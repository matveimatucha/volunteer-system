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

    async function findDuplicateRegistration(eventId, field, value) {
        if (!value) return false;
        const snap = await db.collection('registrations')
            .where('eventId', '==', eventId)
            .where(field, '==', value)
            .limit(5)
            .get();
        return snap.docs.some(d => d.data().status !== REGISTRATION_STATUS.CANCELLED);
    }

    function pickFirstWaitlistDoc(docs) {
        return docs
            .filter(d => getRegistrationStatus(d.data()) === REGISTRATION_STATUS.WAITLIST)
            .sort((a, b) => (a.data().createdAtMs || 0) - (b.data().createdAtMs || 0))[0] || null;
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

    router.post('/registrations', asyncHandler(async (req, res) => {
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

        if (await findDuplicateRegistration(eventId, 'contactEmail', contactEmail)) {
            throw new ApiError(409, 'DUPLICATE_EMAIL');
        }
        if (await findDuplicateRegistration(eventId, 'contactPhone', contactPhone)) {
            throw new ApiError(409, 'DUPLICATE_PHONE');
        }

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
                answersLabeled,
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
        if (req.body) {
            handleTelegramUpdate(req.body, log).catch(() => {});
        }
        res.json({ ok: true });
    }));

    router.get('/registrations/:id', asyncHandler(async (req, res) => {
        const doc = await db.collection('registrations').doc(req.params.id).get();
        if (!doc.exists) throw new ApiError(404, 'NOT_FOUND');

        const reg = doc.data();
        if (reg.cancelToken && reg.cancelToken !== String(req.query.token || '')) {
            throw new ApiError(403, 'FORBIDDEN');
        }

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

    router.post('/registrations/:id/cancel', asyncHandler(async (req, res) => {
        const regRef = db.collection('registrations').doc(req.params.id);
        const token = String((req.body && req.body.token) || '');
        let beforeData = null;
        let afterData = null;

        await db.runTransaction(async (transaction) => {
            const regSnap = await transaction.get(regRef);
            if (!regSnap.exists) throw new ApiError(404, 'NOT_FOUND');

            const reg = regSnap.data();
            beforeData = { ...reg };
            if (reg.cancelToken && reg.cancelToken !== token) {
                throw new ApiError(403, 'FORBIDDEN');
            }
            if (reg.status === REGISTRATION_STATUS.CANCELLED) return;

            const wasConfirmed = isConfirmedRegistration(reg);
            const eventRef = reg.eventId ? db.collection('events').doc(reg.eventId) : null;
            const evSnap = (wasConfirmed && eventRef) ? await transaction.get(eventRef) : null;

            const cancelledAt = new Date().toISOString();
            transaction.update(regRef, {
                status: REGISTRATION_STATUS.CANCELLED,
                cancelledAt
            });
            afterData = { ...reg, status: REGISTRATION_STATUS.CANCELLED, cancelledAt };

            if (evSnap && evSnap.exists) {
                const event = evSnap.data();
                const max = Number(event.maxVolunteers) ? Number(event.maxVolunteers) : 999999;
                const current = Number(event.currentVolunteers) || 0;
                const afterCancel = Math.max(current - 1, 0);
                transaction.update(eventRef, { currentVolunteers: afterCancel });

                if (afterCancel < max && reg.eventId) {
                    const waitlistQuery = db.collection('registrations')
                        .where('eventId', '==', reg.eventId)
                        .where('status', '==', REGISTRATION_STATUS.WAITLIST);
                    const waitlistSnap = await transaction.get(waitlistQuery);
                    const nextWait = pickFirstWaitlistDoc(waitlistSnap.docs);
                    if (nextWait) {
                        transaction.update(nextWait.ref, { status: REGISTRATION_STATUS.CONFIRMED });
                        transaction.update(eventRef, { currentVolunteers: afterCancel + 1 });
                    }
                }
            }
        });

        if (beforeData && afterData && beforeData.status !== afterData.status) {
            scheduleSheetsSync(beforeData, afterData, req.params.id, db);
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
        const event = req.body || {};
        if (!event.title || typeof event.title !== 'string') throw new ApiError(400, 'BAD_REQUEST');
        event.id = req.params.id;
        await db.collection('events').doc(req.params.id).set(event);
        res.json({ ok: true });
    }));

    adminRouter.delete('/events/:id', asyncHandler(async (req, res) => {
        await db.collection('events').doc(req.params.id).delete();
        res.json({ ok: true });
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
        const regSnap = await regRef.get();
        if (!regSnap.exists) {
            res.json({ ok: true });
            return;
        }

        const reg = regSnap.data();
        await regRef.delete();

        if (isConfirmedRegistration(reg) && reg.eventId) {
            await db.collection('events').doc(reg.eventId).update({
                currentVolunteers: admin.firestore.FieldValue.increment(-1)
            }).catch(() => {});
        }
        res.json({ ok: true });
    }));

    adminRouter.put('/registrations/:id', asyncHandler(async (req, res) => {
        const regRef = db.collection('registrations').doc(req.params.id);
        const regSnap = await regRef.get();
        if (!regSnap.exists) throw new ApiError(404, 'NOT_FOUND');

        const body = req.body || {};
        const allowed = ['status', 'contactEmail', 'contactPhone', 'answers', 'answersLabeled'];
        const patch = {};
        for (const key of allowed) {
            if (body[key] !== undefined) patch[key] = body[key];
        }
        if (!Object.keys(patch).length) throw new ApiError(400, 'BAD_REQUEST');

        if (patch.answers && (typeof patch.answers !== 'object' || Array.isArray(patch.answers))) {
            throw new ApiError(400, 'BAD_REQUEST');
        }

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

        const byKey = {};
        regSnap.docs.forEach(doc => {
            const r = doc.data();
            if (r.status === REGISTRATION_STATUS.CANCELLED) return;
            const key = r.contactEmail || r.contactPhone || r.registrationId || doc.id;
            if (!key) return;

            if (!byKey[key]) {
                byKey[key] = {
                    key,
                    name: '',
                    firstName: '',
                    lastName: '',
                    middleName: '',
                    faculty: '',
                    year: '',
                    vk: '',
                    email: r.contactEmail || '',
                    phone: r.contactPhone || '',
                    totalConfirmed: 0,
                    presentCount: 0,
                    totalHours: 0,
                    events: []
                };
            }

            const entry = byKey[key];
            if (Array.isArray(r.answersLabeled)) {
                for (const item of r.answersLabeled) {
                    const q = (item.question || '').toLowerCase();
                    const a = String(item.answer || '').trim();
                    if (!a) continue;

                    if (!entry.lastName && /фамил/.test(q)) entry.lastName = a;
                    if (!entry.firstName && (q.includes('имя') || q.includes('name'))) entry.firstName = a;
                    if (!entry.middleName && /отчест/.test(q)) entry.middleName = a;
                    if (!entry.name && /фио|ф\.и\.о/.test(q)) entry.name = a;
                    if (!entry.faculty && /факульт|школ|институт|кафедр|направлен/.test(q)) entry.faculty = a;
                    if (!entry.year && /курс|год об|учеб/.test(q)) entry.year = a;
                    if (!entry.vk && /вк|вконтакте|vk|vkontakte/.test(q)) entry.vk = a;
                }
            }

            if (!entry.name) {
                const fullName = [entry.lastName, entry.firstName, entry.middleName].filter(Boolean).join(' ').trim();
                if (fullName) entry.name = fullName;
            }
            if (!entry.name) entry.name = r.contactEmail || r.contactPhone || '';

            if (isConfirmedRegistration(r)) entry.totalConfirmed++;
            if (r.attendance === 'present' || r.attendance === 'late') {
                entry.presentCount++;
                entry.totalHours += Number(r.workedHours) || 0;
            }

            entry.events.push({
                eventId: r.eventId || '',
                eventTitle: r.eventTitle || eventTitles[r.eventId] || r.eventId || '',
                status: r.status || '',
                attendance: r.attendance || null,
                workedHours: r.workedHours != null ? Number(r.workedHours) : null,
                registrationId: r.registrationId || doc.id
            });
        });

        const volunteers = Object.values(byKey).sort((a, b) => b.totalHours - a.totalHours);
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
