const express = require('express');
const crypto = require('crypto');

const {
    REGISTRATION_STATUS,
    findContactEmail,
    findContactPhone,
    getRegistrationStatus,
    isConfirmedRegistration,
    isEventClosedForRegistration,
    isEventHidden,
    isMultiDayEvent,
    sanitizeSelectedDays,
    withSelectedDaysLabeled,
    enumerateEventDays,
    buildVolunteerStats,
    buildSheetsBulkRow
} = require('./registration-helpers');
const { getSheetsUrl, postToSheets, scheduleSheetsSync } = require('./sheets-sync');
const {
    scheduleRegistrationTelegram,
    getBotToken,
    getRecipientChatIds,
    handleTelegramUpdate
} = require('./telegram-notify');

class ApiError extends Error {
    constructor(httpStatus, code) {
        super(code);
        this.httpStatus = httpStatus;
        this.code = code;
    }
}

function createRateLimiter({ windowMs = 60_000, max = 12 } = {}) {
    const hits = new Map();
    return (req, res, next) => {
        const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
        const key = forwarded || req.ip || (req.socket && req.socket.remoteAddress) || 'unknown';
        const now = Date.now();
        const recent = (hits.get(key) || []).filter(t => now - t < windowMs);
        if (recent.length >= max) {
            res.status(429).json({ error: 'RATE_LIMIT' });
            return;
        }
        recent.push(now);
        hits.set(key, recent);
        if (hits.size > 4000) {
            for (const [ip, times] of hits) {
                if (!times.length || now - times[times.length - 1] > windowMs) hits.delete(ip);
            }
        }
        next();
    };
}

function assertCancelToken(reg, token) {
    if (!reg.cancelToken || reg.cancelToken !== String(token || '')) {
        throw new ApiError(403, 'FORBIDDEN');
    }
}

function createApp({ admin, db, log = console }) {
    function asyncHandler(fn) {
        return (req, res) => {
            Promise.resolve(fn(req, res)).catch((err) => {
                if (err instanceof ApiError) {
                    res.status(err.httpStatus).json({ error: err.code });
                    return;
                }
                log.error('Unhandled API error', err);
                res.status(500).json({ error: 'INTERNAL' });
            });
        };
    }

    function eventFromDoc(doc) {
        const data = doc.data();
        return { ...data, id: data.id || doc.id };
    }

    function registrationFromDoc(doc) {
        const data = doc.data();
        const { cancelToken, ...rest } = data;
        return { ...rest, registrationId: data.registrationId || doc.id };
    }

    function sanitizeAnswers(rawAnswers, rawAnswersLabeled) {
        if (!rawAnswers || typeof rawAnswers !== 'object' || Array.isArray(rawAnswers)) {
            throw new ApiError(400, 'BAD_REQUEST');
        }
        const answers = {};
        const entries = Object.entries(rawAnswers).slice(0, 60);
        for (const [key, value] of entries) {
            answers[String(key).slice(0, 100)] = String(value ?? '').slice(0, 3000);
        }

        const answersLabeled = [];
        if (Array.isArray(rawAnswersLabeled)) {
            for (const item of rawAnswersLabeled.slice(0, 60)) {
                if (!item || typeof item !== 'object') continue;
                answersLabeled.push({
                    question: String(item.question ?? '').slice(0, 300),
                    answer: String(item.answer ?? '').slice(0, 3000)
                });
            }
        }
        return { answers, answersLabeled };
    }

    async function findDuplicateRegistration(eventId, field, value, transaction) {
        if (!value) return false;
        const query = db.collection('registrations')
            .where('eventId', '==', eventId)
            .where(field, '==', value)
            .limit(5);
        const snap = transaction ? await transaction.get(query) : await query.get();
        return snap.docs.some(d => d.data().status !== REGISTRATION_STATUS.CANCELLED);
    }

    function assertRequiredAnswers(answers, questions) {
        const list = Array.isArray(questions) ? questions : [];
        if (!list.length) {
            const hasName = String(answers.name || '').trim().length >= 2;
            const hasContact = !!(findContactEmail(answers, list) || findContactPhone(answers, list) || answers.email || answers.phone);
            if (!hasName || !hasContact) throw new ApiError(400, 'MISSING_REQUIRED');
            return;
        }
        for (const q of list) {
            if (!q || q.type === 'infotext' || !q.required) continue;
            const value = answers[`question_${q.id}`];
            if (value == null || String(value).trim() === '') {
                throw new ApiError(400, 'MISSING_REQUIRED');
            }
        }
    }

    function pickFirstWaitlistDoc(docs) {
        return docs
            .filter(d => getRegistrationStatus(d.data()) === REGISTRATION_STATUS.WAITLIST)
            .sort((a, b) => (a.data().createdAtMs || 0) - (b.data().createdAtMs || 0))[0] || null;
    }

    async function vacateConfirmedSpot(transaction, reg) {
        if (!reg.eventId) return null;
        const eventRef = db.collection('events').doc(reg.eventId);
        const waitlistQuery = db.collection('registrations')
            .where('eventId', '==', reg.eventId)
            .where('status', '==', REGISTRATION_STATUS.WAITLIST);
        const [evSnap, waitlistSnap] = await Promise.all([
            transaction.get(eventRef),
            transaction.get(waitlistQuery)
        ]);
        if (!evSnap.exists) return null;

        const event = evSnap.data();
        const max = Number(event.maxVolunteers) ? Number(event.maxVolunteers) : 999999;
        const current = Number(event.currentVolunteers) || 0;
        const afterCancel = Math.max(current - 1, 0);
        const nextWait = afterCancel < max ? pickFirstWaitlistDoc(waitlistSnap.docs) : null;

        if (nextWait) {
            transaction.update(nextWait.ref, { status: REGISTRATION_STATUS.CONFIRMED });
            transaction.update(eventRef, { currentVolunteers: afterCancel + 1 });
            return {
                id: nextWait.id,
                before: nextWait.data(),
                after: { ...nextWait.data(), status: REGISTRATION_STATUS.CONFIRMED }
            };
        }

        transaction.update(eventRef, { currentVolunteers: afterCancel });
        return null;
    }

    function sanitizeEventPayload(raw, eventId) {
        const src = raw && typeof raw === 'object' ? raw : {};
        const status = ['open', 'draft', 'closed'].includes(src.status) ? src.status : 'open';
        const questions = Array.isArray(src.questions)
            ? src.questions.slice(0, 60).map((q) => {
                if (!q || typeof q !== 'object') return null;
                return {
                    id: q.id,
                    text: String(q.text ?? '').slice(0, 500),
                    type: String(q.type ?? 'text').slice(0, 40),
                    required: q.required === true,
                    description: String(q.description ?? '').slice(0, 1000),
                    options: Array.isArray(q.options)
                        ? q.options.slice(0, 40).map(opt => String(opt ?? '').slice(0, 200))
                        : []
                };
            }).filter(Boolean)
            : [];
        const dateRaw = String(src.dateRaw || '').slice(0, 40);
        let dateEndRaw = String(src.dateEndRaw || '').slice(0, 40);
        let dateEnd = String(src.dateEnd || '').slice(0, 80);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(dateEndRaw) || dateEndRaw === dateRaw || (dateRaw && dateEndRaw < dateRaw)) {
            dateEndRaw = '';
            dateEnd = '';
        } else if (dateRaw) {
            const days = enumerateEventDays({ dateRaw, dateEndRaw });
            if (days.length) {
                dateEndRaw = days[days.length - 1];
            }
        }
        return {
            id: eventId,
            title: String(src.title || '').trim().slice(0, 300),
            dateRaw,
            date: String(src.date || '').slice(0, 80),
            dateEndRaw,
            dateEnd,
            location: String(src.location || '').slice(0, 300),
            description: String(src.description || '').slice(0, 5000),
            maxVolunteers: Math.max(0, Number(src.maxVolunteers) || 0),
            currentVolunteers: Math.max(0, Number(src.currentVolunteers) || 0),
            color: String(src.color || '#ff6b35').slice(0, 20),
            status,
            successMessage: String(src.successMessage || '').slice(0, 2000),
            chatLink: String(src.chatLink || '').slice(0, 500),
            isTemplate: src.isTemplate === true,
            isArchived: src.isArchived === true,
            image: String(src.image || '').slice(0, 1000),
            logo: String(src.logo || '').slice(0, 1000),
            archivePhoto: String(src.archivePhoto || '').slice(0, 1000),
            archiveText: String(src.archiveText || '').slice(0, 4000),
            questions
        };
    }

    async function requireAdmin(req, res, next) {
        const match = String(req.headers.authorization || '').match(/^Bearer (.+)$/);
        if (!match) {
            res.status(401).json({ error: 'UNAUTHORIZED' });
            return;
        }
        try {
            const decoded = await admin.auth().verifyIdToken(match[1]);
            if (decoded.admin !== true) {
                res.status(403).json({ error: 'FORBIDDEN' });
                return;
            }
            req.user = decoded;
            next();
        } catch (err) {
            res.status(401).json({ error: 'UNAUTHORIZED' });
        }
    }

    const router = express.Router();
    const writeLimiter = createRateLimiter({ windowMs: 60_000, max: 12 });

    router.get('/events', asyncHandler(async (req, res) => {
        const snap = await db.collection('events').get();
        const events = snap.docs.map(eventFromDoc).filter(e => !isEventHidden(e));
        res.json({ events });
    }));

    router.get('/events/:id', asyncHandler(async (req, res) => {
        const doc = await db.collection('events').doc(req.params.id).get();
        if (!doc.exists) throw new ApiError(404, 'EVENT_NOT_FOUND');
        const event = eventFromDoc(doc);
        if (isEventHidden(event)) throw new ApiError(404, 'EVENT_NOT_FOUND');
        res.json({ event });
    }));

    router.post('/registrations', writeLimiter, asyncHandler(async (req, res) => {
        const body = req.body || {};
        const eventId = typeof body.eventId === 'string' ? body.eventId.trim() : '';
        if (!eventId) throw new ApiError(400, 'BAD_REQUEST');

        const { answers, answersLabeled } = sanitizeAnswers(body.answers, body.answersLabeled);
        const wantsWaitlist = body.waitlist === true;

        const eventRef = db.collection('events').doc(eventId);
        const preSnap = await eventRef.get();
        if (!preSnap.exists) throw new ApiError(404, 'EVENT_NOT_FOUND');

        const questions = preSnap.data().questions || [];
        const contactEmail = findContactEmail(answers, questions);
        const contactPhone = findContactPhone(answers, questions);
        assertRequiredAnswers(answers, questions);

        const selectedDays = sanitizeSelectedDays(body.selectedDays, preSnap.data());
        if (isMultiDayEvent(preSnap.data()) && selectedDays.length === 0) {
            throw new ApiError(400, 'MISSING_DAYS');
        }
        const labeled = withSelectedDaysLabeled(answersLabeled, selectedDays);

        const registrationRef = db.collection('registrations').doc();
        const cancelToken = crypto.randomBytes(16).toString('hex');
        let savedStatus = REGISTRATION_STATUS.CONFIRMED;
        let latestEvent = null;

        await db.runTransaction(async (transaction) => {
            const eventSnap = await transaction.get(eventRef);
            if (!eventSnap.exists) throw new ApiError(404, 'EVENT_NOT_FOUND');

            latestEvent = eventSnap.data();
            if (isEventClosedForRegistration(latestEvent)) {
                throw new ApiError(409, 'REGISTRATION_CLOSED');
            }
            if (await findDuplicateRegistration(eventId, 'contactEmail', contactEmail, transaction)) {
                throw new ApiError(409, 'DUPLICATE_EMAIL');
            }
            if (await findDuplicateRegistration(eventId, 'contactPhone', contactPhone, transaction)) {
                throw new ApiError(409, 'DUPLICATE_PHONE');
            }

            const max = Number(latestEvent.maxVolunteers) ? Number(latestEvent.maxVolunteers) : 999999;
            const current = Number(latestEvent.currentVolunteers) || 0;
            const savingAsWaitlist = wantsWaitlist || current >= max;
            savedStatus = savingAsWaitlist ? REGISTRATION_STATUS.WAITLIST : REGISTRATION_STATUS.CONFIRMED;

            transaction.set(registrationRef, {
                registrationId: registrationRef.id,
                eventId,
                eventTitle: latestEvent.title,
                status: savedStatus,
                contactEmail: contactEmail || '',
                contactPhone: contactPhone || '',
                createdAt: new Date().toISOString(),
                createdAtMs: Date.now(),
                timestamp: new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' }),
                answers,
                answersLabeled: labeled,
                selectedDays,
                cancelToken
            });

            if (!savingAsWaitlist) {
                transaction.update(eventRef, {
                    currentVolunteers: admin.firestore.FieldValue.increment(1)
                });
            }
        });

        const savedSnap = await registrationRef.get();
        scheduleSheetsSync(null, savedSnap.data(), registrationRef.id, db);
        scheduleRegistrationTelegram(db, registrationRef.id, savedSnap.data(), log);

        res.status(201).json({
            registrationId: registrationRef.id,
            status: savedStatus,
            cancelToken,
            event: { ...latestEvent, id: eventId }
        });
    }));

    router.get('/telegram/status', asyncHandler(async (req, res) => {
        const snap = await db.collection('settings').doc('notifications').get();
        const data = snap.data() || {};
        const chatIds = await getRecipientChatIds(db);
        res.json({
            botConfigured: !!getBotToken(),
            enabled: data.telegramEnabled !== false,
            recipientCount: chatIds.length
        });
    }));

    router.post('/telegram/webhook', asyncHandler(async (req, res) => {
        const expected = (process.env.TELEGRAM_WEBHOOK_SECRET || '').trim();
        const provided = String(req.headers['x-telegram-bot-api-secret-token'] || req.query.secret || '');
        if (expected && provided !== expected) {
            throw new ApiError(403, 'FORBIDDEN');
        }
        if (req.body) {
            handleTelegramUpdate(req.body, log).catch(() => {});
        }
        res.json({ ok: true });
    }));

    router.get('/registrations/:id', asyncHandler(async (req, res) => {
        const doc = await db.collection('registrations').doc(req.params.id).get();
        if (!doc.exists) throw new ApiError(404, 'NOT_FOUND');

        const reg = doc.data();
        assertCancelToken(reg, req.query.token);

        let eventTitle = reg.eventTitle || '';
        try {
            const evSnap = await db.collection('events').doc(reg.eventId).get();
            if (evSnap.exists) eventTitle = evSnap.data().title || eventTitle;
        } catch (_) {}

        res.json({
            registrationId: doc.id,
            status: reg.status || REGISTRATION_STATUS.CONFIRMED,
            eventId: reg.eventId || '',
            eventTitle
        });
    }));

    router.post('/registrations/:id/cancel', writeLimiter, asyncHandler(async (req, res) => {
        const regRef = db.collection('registrations').doc(req.params.id);
        const token = String((req.body && req.body.token) || '');
        let beforeData = null;
        let afterData = null;
        let promoted = null;

        await db.runTransaction(async (transaction) => {
            const regSnap = await transaction.get(regRef);
            if (!regSnap.exists) throw new ApiError(404, 'NOT_FOUND');

            const reg = regSnap.data();
            beforeData = { ...reg };
            assertCancelToken(reg, token);
            if (reg.status === REGISTRATION_STATUS.CANCELLED) return;

            if (isConfirmedRegistration(reg)) {
                promoted = await vacateConfirmedSpot(transaction, reg);
            }

            const cancelledAt = new Date().toISOString();
            transaction.update(regRef, {
                status: REGISTRATION_STATUS.CANCELLED,
                cancelledAt
            });
            afterData = { ...reg, status: REGISTRATION_STATUS.CANCELLED, cancelledAt };
        });

        if (beforeData && afterData && beforeData.status !== afterData.status) {
            scheduleSheetsSync(beforeData, afterData, req.params.id, db);
        }
        if (promoted) {
            scheduleSheetsSync(promoted.before, promoted.after, promoted.id, db);
        }

        res.json({ ok: true });
    }));

    const adminRouter = express.Router();
    adminRouter.use(requireAdmin);

    adminRouter.get('/events', asyncHandler(async (req, res) => {
        const snap = await db.collection('events').get();
        res.json({ events: snap.docs.map(eventFromDoc) });
    }));

    adminRouter.put('/events/:id', asyncHandler(async (req, res) => {
        const event = sanitizeEventPayload(req.body, req.params.id);
        if (!event.title) throw new ApiError(400, 'BAD_REQUEST');
        await db.collection('events').doc(req.params.id).set(event);
        res.json({ ok: true });
    }));

    adminRouter.delete('/events/:id', asyncHandler(async (req, res) => {
        const eventId = req.params.id;
        const regs = await db.collection('registrations').where('eventId', '==', eventId).get();
        const docs = regs.docs;
        const chunkSize = 400;
        if (!docs.length) {
            await db.collection('events').doc(eventId).delete();
        } else {
            for (let i = 0; i < docs.length; i += chunkSize) {
                const batch = db.batch();
                docs.slice(i, i + chunkSize).forEach(doc => batch.delete(doc.ref));
                if (i === 0) batch.delete(db.collection('events').doc(eventId));
                await batch.commit();
            }
        }
        res.json({ ok: true, deletedRegistrations: docs.length });
    }));

    adminRouter.post('/events/:id/recount', asyncHandler(async (req, res) => {
        const snap = await db.collection('registrations')
            .where('eventId', '==', req.params.id)
            .get();
        const count = snap.docs.filter(d => isConfirmedRegistration(d.data())).length;
        await db.collection('events').doc(req.params.id).update({ currentVolunteers: count });
        res.json({ ok: true, count });
    }));

    adminRouter.get('/registrations', asyncHandler(async (req, res) => {
        const eventId = typeof req.query.eventId === 'string' ? req.query.eventId : '';
        let query = db.collection('registrations');
        if (eventId) query = query.where('eventId', '==', eventId);
        const snap = await query.get();
        res.json({ registrations: snap.docs.map(registrationFromDoc) });
    }));

    adminRouter.delete('/registrations/:id', asyncHandler(async (req, res) => {
        const regRef = db.collection('registrations').doc(req.params.id);
        let deletedReg = null;
        let promoted = null;

        await db.runTransaction(async (transaction) => {
            const regSnap = await transaction.get(regRef);
            if (!regSnap.exists) return;

            const reg = regSnap.data();
            deletedReg = { ...reg };

            if (isConfirmedRegistration(reg) && reg.eventId) {
                promoted = await vacateConfirmedSpot(transaction, reg);
            }
            transaction.delete(regRef);
        });

        if (deletedReg) {
            scheduleSheetsSync(deletedReg, {
                ...deletedReg,
                status: REGISTRATION_STATUS.CANCELLED,
                cancelledAt: new Date().toISOString()
            }, req.params.id, db);
        }
        if (promoted) {
            scheduleSheetsSync(promoted.before, promoted.after, promoted.id, db);
        }
        res.json({ ok: true });
    }));

    adminRouter.put('/registrations/:id', asyncHandler(async (req, res) => {
        const regRef = db.collection('registrations').doc(req.params.id);
        const body = req.body || {};
        const allowed = ['contactEmail', 'contactPhone', 'answers', 'answersLabeled'];
        const patch = {};
        for (const key of allowed) {
            if (body[key] !== undefined) patch[key] = body[key];
        }
        if (patch.answers) {
            const sanitized = sanitizeAnswers(patch.answers, patch.answersLabeled);
            patch.answers = sanitized.answers;
            if (patch.answersLabeled !== undefined) patch.answersLabeled = sanitized.answersLabeled;
        } else if (patch.answersLabeled !== undefined && !Array.isArray(patch.answersLabeled)) {
            throw new ApiError(400, 'BAD_REQUEST');
        }
        if (typeof patch.contactEmail === 'string') patch.contactEmail = patch.contactEmail.slice(0, 200);
        if (typeof patch.contactPhone === 'string') patch.contactPhone = patch.contactPhone.slice(0, 40);
        if (!Object.keys(patch).length) throw new ApiError(400, 'BAD_REQUEST');

        const snap = await regRef.get();
        if (!snap.exists) throw new ApiError(404, 'NOT_FOUND');
        await regRef.update(patch);
        res.json({ ok: true });
    }));

    adminRouter.patch('/registrations/:id/attendance', asyncHandler(async (req, res) => {
        const regRef = db.collection('registrations').doc(req.params.id);
        const regSnap = await regRef.get();
        if (!regSnap.exists) throw new ApiError(404, 'NOT_FOUND');

        const body = req.body || {};
        const patch = {};

        if (body.attendance !== undefined) {
            const validValues = ['present', 'absent', 'late', null];
            if (!validValues.includes(body.attendance)) throw new ApiError(400, 'BAD_REQUEST');
            patch.attendance = body.attendance;
        }
        if (body.workedHours !== undefined) {
            if (body.workedHours !== null) {
                const h = Number(body.workedHours);
                if (isNaN(h) || h < 0 || h > 72) throw new ApiError(400, 'BAD_REQUEST');
                patch.workedHours = h;
            } else {
                patch.workedHours = null;
            }
        }
        if (body.coordinatorNote !== undefined) {
            patch.coordinatorNote = String(body.coordinatorNote || '').slice(0, 1000);
        }

        if (!Object.keys(patch).length) throw new ApiError(400, 'BAD_REQUEST');
        await regRef.update(patch);
        res.json({ ok: true });
    }));

    adminRouter.get('/events/:id/attendance-stats', asyncHandler(async (req, res) => {
        const snap = await db.collection('registrations')
            .where('eventId', '==', req.params.id)
            .get();

        const regs = snap.docs.map(d => d.data());
        const confirmed = regs.filter(isConfirmedRegistration);
        const present = regs.filter(r => r.attendance === 'present');
        const late = regs.filter(r => r.attendance === 'late');
        const absent = regs.filter(r => r.attendance === 'absent');
        const totalHours = regs.reduce((sum, r) => sum + (Number(r.workedHours) || 0), 0);
        const marked = present.length + late.length + absent.length;
        const attendanceRate = confirmed.length
            ? Math.round((present.length + late.length) / confirmed.length * 100)
            : 0;

        res.json({
            total: regs.length,
            confirmed: confirmed.length,
            present: present.length,
            late: late.length,
            absent: absent.length,
            noMark: confirmed.length - marked,
            totalHours,
            attendanceRate
        });
    }));

    adminRouter.get('/volunteer-stats', asyncHandler(async (req, res) => {
        const [evSnap, regSnap] = await Promise.all([
            db.collection('events').get(),
            db.collection('registrations').get()
        ]);

        const eventTitles = {};
        evSnap.forEach(doc => { eventTitles[doc.id] = doc.data().title || doc.id; });

        const volunteers = buildVolunteerStats(regSnap.docs, eventTitles);
        res.json({ volunteers });
    }));

    adminRouter.get('/settings/notifications', asyncHandler(async (req, res) => {
        const snap = await db.collection('settings').doc('notifications').get();
        const data = snap.exists ? snap.data() : {};
        res.json({
            telegramEnabled: data.telegramEnabled !== false,
            telegramChatIds: Array.isArray(data.telegramChatIds)
                ? data.telegramChatIds.map(String)
                : []
        });
    }));

    adminRouter.put('/settings/notifications', asyncHandler(async (req, res) => {
        const body = req.body || {};
        const telegramChatIds = Array.isArray(body.telegramChatIds)
            ? body.telegramChatIds.map(String).filter(Boolean)
            : [];
        await db.collection('settings').doc('notifications').set({
            telegramEnabled: body.telegramEnabled !== false,
            telegramChatIds,
            updatedAt: new Date().toISOString()
        }, { merge: true });
        res.json({ ok: true });
    }));

    adminRouter.get('/settings/integrations', asyncHandler(async (req, res) => {
        const snap = await db.collection('settings').doc('integrations').get();
        const data = snap.exists ? snap.data() : {};
        res.json({
            sheetsWebhookUrl: data.sheetsWebhookUrl || '',
            sheetsSpreadsheetUrl: data.sheetsSpreadsheetUrl || ''
        });
    }));

    adminRouter.put('/settings/integrations', asyncHandler(async (req, res) => {
        const body = req.body || {};
        const patch = { updatedAt: new Date().toISOString() };
        if (typeof body.sheetsWebhookUrl === 'string') {
            patch.sheetsWebhookUrl = body.sheetsWebhookUrl.trim();
        }
        if (typeof body.sheetsSpreadsheetUrl === 'string') {
            patch.sheetsSpreadsheetUrl = body.sheetsSpreadsheetUrl.trim();
        }
        await db.collection('settings').doc('integrations').set(patch, { merge: true });
        res.json({ ok: true });
    }));

    adminRouter.post('/registrations/:id/promote', asyncHandler(async (req, res) => {
        const regRef = db.collection('registrations').doc(req.params.id);
        let beforeData = null;
        let afterData = null;

        await db.runTransaction(async (transaction) => {
            const regSnap = await transaction.get(regRef);
            if (!regSnap.exists) throw new ApiError(404, 'NOT_FOUND');

            const reg = regSnap.data();
            beforeData = { ...reg };
            const currentStatus = getRegistrationStatus(reg);
            if (currentStatus === REGISTRATION_STATUS.CONFIRMED) return;
            if (currentStatus === REGISTRATION_STATUS.CANCELLED) {
                throw new ApiError(409, 'CANCELLED');
            }
            const eventRef = db.collection('events').doc(reg.eventId);
            const eventSnap = await transaction.get(eventRef);
            if (!eventSnap.exists) throw new ApiError(404, 'NOT_FOUND');

            const event = eventSnap.data();
            const max = Number(event.maxVolunteers) ? Number(event.maxVolunteers) : 999999;
            const current = Number(event.currentVolunteers) || 0;
            if (current >= max) throw new ApiError(409, 'NO_SPOTS');

            transaction.update(regRef, { status: REGISTRATION_STATUS.CONFIRMED });
            transaction.update(eventRef, {
                currentVolunteers: admin.firestore.FieldValue.increment(1)
            });
            afterData = { ...reg, status: REGISTRATION_STATUS.CONFIRMED };
        });

        if (beforeData && afterData) {
            scheduleSheetsSync(beforeData, afterData, req.params.id, db);
        }

        res.json({ ok: true });
    }));

    adminRouter.get('/sheets/status', asyncHandler(async (req, res) => {
        const url = getSheetsUrl();
        if (!url) {
            res.json({ configured: false });
            return;
        }
        try {
            const ping = await fetch(url + '?ping=1', { redirect: 'follow' });
            const json = await ping.json();
            res.json({ configured: true, ok: json.ok === true, sheet: json.sheet || '' });
        } catch (err) {
            res.json({ configured: true, ok: false });
        }
    }));

    adminRouter.post('/sheets/bulk-sync', asyncHandler(async (req, res) => {
        const url = getSheetsUrl();
        if (!url) throw new ApiError(409, 'SHEETS_NOT_CONFIGURED');

        const [evSnap, regSnap] = await Promise.all([
            db.collection('events').get(),
            db.collection('registrations').get()
        ]);

        const eventTitleById = {};
        evSnap.forEach(doc => { eventTitleById[doc.id] = doc.data().title || doc.id; });

        const registrations = regSnap.docs
            .map(doc => buildSheetsBulkRow(doc.id, doc.data(), eventTitleById))
            .sort((a, b) => (Number(a.createdAtMs) || 0) - (Number(b.createdAtMs) || 0));

        const response = await fetch(url, {
            method: 'POST',
            redirect: 'follow',
            headers: { 'Content-Type': 'text/plain' },
            body: JSON.stringify({ action: 'bulk_sync', registrations })
        });
        if (!response.ok) {
            log.error('Sheets bulk_sync failed', { status: response.status });
            throw new ApiError(502, 'SHEETS_ERROR');
        }

        res.json({ ok: true, count: registrations.length });
    }));

    const app = express();
    app.use(express.json({ limit: '1mb' }));
    router.use('/admin', adminRouter);
    app.use('/api', router);
    app.use('/', router);
    app.use((req, res) => res.status(404).json({ error: 'NOT_FOUND' }));

    return app;
}

module.exports = { createApp, ApiError };
