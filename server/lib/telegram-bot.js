const {
    extractCommonFields,
    isConfirmedRegistration,
    isEventClosedForRegistration
} = require('./registration-helpers');
const { relayTelegram } = require('./telegram-notify');

const INTERVAL_MS = 3 * 60 * 60 * 1000;
const DAILY_HOUR_MSK = 21;
const MOSCOW_OFFSET_MS = 3 * 60 * 60 * 1000;

function curatorRef(db, chatId) {
    return db.collection('telegramCurators').doc(String(chatId));
}

function modeLabel(mode) {
    if (mode === 'instant') return 'каждая заявка';
    if (mode === 'daily') return 'раз в день, в 21:00';
    return 'каждые 3 часа';
}

function keyboard(rows) {
    return { inline_keyboard: rows };
}

function mainKeyboard() {
    return keyboard([
        [{ text: 'Мероприятия на записи', callback_data: 'l' }],
        [{ text: 'Сводка по всем', callback_data: 'a' }],
        [{ text: 'Мои подписки', callback_data: 's' }]
    ]);
}

function eventKeyboard(eventId, subscribed) {
    const id = String(eventId);
    const rows = [
        [{ text: 'Каждая заявка', callback_data: `m:i:${id}` }],
        [{ text: 'Каждые 3 часа', callback_data: `m:h:${id}` }],
        [{ text: 'Раз в день, в 21:00', callback_data: `m:d:${id}` }],
        [{ text: 'Сколько сейчас', callback_data: `c:${id}` }]
    ];
    if (subscribed) rows.push([{ text: 'Не следить', callback_data: `x:${id}` }]);
    rows.push([{ text: 'К списку', callback_data: 'l' }]);
    return keyboard(rows);
}

function isOpenEvent(event) {
    return event && event.isLegacyImport !== true && !isEventClosedForRegistration(event);
}

function dailySlotStartMs(now) {
    const shifted = new Date(now + MOSCOW_OFFSET_MS);
    return Date.UTC(
        shifted.getUTCFullYear(),
        shifted.getUTCMonth(),
        shifted.getUTCDate(),
        DAILY_HOUR_MSK - 3,
        0,
        0
    );
}

function digestDue(mode, lastDigestAt, now) {
    const last = Number(lastDigestAt) || 0;
    if (mode === 'interval') return !last || now - last >= INTERVAL_MS;
    if (mode === 'daily') {
        const slot = dailySlotStartMs(now);
        return now >= slot && last < slot;
    }
    return false;
}

async function loadCurator(db, chatId) {
    const snap = await curatorRef(db, chatId).get();
    if (!snap.exists) return null;
    const data = snap.data() || {};
    return {
        ...data,
        chatId: String(chatId),
        subscriptions: Array.isArray(data.subscriptions) ? data.subscriptions : []
    };
}

async function saveCurator(db, curator) {
    const chatId = String(curator.chatId);
    await curatorRef(db, chatId).set({
        chatId,
        status: curator.status || 'pending',
        firstName: curator.firstName || '',
        username: curator.username || '',
        requestedAt: curator.requestedAt || new Date().toISOString(),
        approvedAt: curator.approvedAt || '',
        subscriptions: (curator.subscriptions || []).map(item => ({
            eventId: String(item.eventId || ''),
            mode: item.mode || 'instant',
            lastDigestAt: Number(item.lastDigestAt) || 0
        }))
    });
}

async function openEvents(db) {
    const snap = await db.collection('events').get();
    return snap.docs
        .map(doc => ({ ...doc.data(), id: doc.id }))
        .filter(isOpenEvent)
        .sort((a, b) => String(a.dateRaw || '').localeCompare(String(b.dateRaw || '')));
}

async function confirmedCount(db, eventId) {
    const snap = await db.collection('registrations').where('eventId', '==', eventId).get();
    return snap.docs.filter(doc => isConfirmedRegistration(doc.data())).length;
}

async function newRegistrationsSince(db, eventId, sinceMs) {
    const snap = await db.collection('registrations').where('eventId', '==', eventId).get();
    return snap.docs
        .map(doc => doc.data())
        .filter(reg => isConfirmedRegistration(reg) && (Number(reg.createdAtMs) || 0) > sinceMs)
        .sort((a, b) => (Number(a.createdAtMs) || 0) - (Number(b.createdAtMs) || 0));
}

function personName(reg) {
    const common = extractCommonFields(reg.answersLabeled);
    return common.name || reg.contactEmail || 'без имени';
}

function clip(text, max) {
    const value = String(text || '');
    return value.length > max ? value.slice(0, max - 1) + '…' : value;
}

async function reply(db, chatId, text, replyMarkup, callbackQueryId, log) {
    await relayTelegram(db, {
        chatIds: [String(chatId)],
        text,
        replyMarkup,
        callbackQueryId
    }, log);
}

async function ensurePending(db, chatId, from) {
    let curator = await loadCurator(db, chatId);
    if (!curator) {
        curator = {
            chatId: String(chatId),
            status: 'pending',
            firstName: (from && from.first_name) || '',
            username: (from && from.username) || '',
            requestedAt: new Date().toISOString(),
            subscriptions: []
        };
        await saveCurator(db, curator);
        return { curator, created: true };
    }
    if (curator.status === 'rejected') {
        curator.status = 'pending';
        curator.requestedAt = new Date().toISOString();
        await saveCurator(db, curator);
        return { curator, created: true };
    }
    return { curator, created: false };
}

async function sendMainMenu(db, chatId, log, callbackQueryId) {
    await reply(db, chatId, 'Выберите, что сделать.', mainKeyboard(), callbackQueryId, log);
}

async function sendEventList(db, chatId, log, callbackQueryId) {
    const events = (await openEvents(db)).slice(0, 20);
    if (!events.length) {
        await reply(db, chatId, 'Сейчас нет мероприятий с открытой записью.', mainKeyboard(), callbackQueryId, log);
        return;
    }
    const rows = events.map(event => [{
        text: clip(event.title || 'Мероприятие', 40),
        callback_data: `e:${event.id}`
    }]);
    rows.push([{ text: 'В меню', callback_data: 'menu' }]);
    await reply(db, chatId, 'Какое мероприятие отслеживать?', keyboard(rows), callbackQueryId, log);
}

async function sendEventMenu(db, chatId, eventId, log, callbackQueryId) {
    const snap = await db.collection('events').doc(String(eventId)).get();
    if (!snap.exists) {
        await reply(db, chatId, 'Это мероприятие уже недоступно.', mainKeyboard(), callbackQueryId, log);
        return;
    }
    const event = snap.data();
    const curator = await loadCurator(db, chatId);
    const sub = (curator && curator.subscriptions || []).find(item => item.eventId === String(eventId));
    const current = sub ? `\nСейчас: ${modeLabel(sub.mode)}.` : '';
    await reply(
        db,
        chatId,
        `${event.title || 'Мероприятие'}${current}\nКак следить?`,
        eventKeyboard(eventId, !!sub),
        callbackQueryId,
        log
    );
}

async function setMode(db, chatId, eventId, mode, log, callbackQueryId) {
    const curator = await loadCurator(db, chatId);
    if (!curator || curator.status !== 'approved') return;
    const subscriptions = curator.subscriptions.filter(item => item.eventId !== String(eventId));
    subscriptions.push({ eventId: String(eventId), mode, lastDigestAt: Date.now() });
    curator.subscriptions = subscriptions;
    await saveCurator(db, curator);
    const snap = await db.collection('events').doc(String(eventId)).get();
    const title = snap.exists ? (snap.data().title || 'мероприятие') : 'мероприятие';
    await reply(db, chatId, `Буду присылать «${title}»: ${modeLabel(mode)}.`, mainKeyboard(), callbackQueryId, log);
}

async function clearMode(db, chatId, eventId, log, callbackQueryId) {
    const curator = await loadCurator(db, chatId);
    if (!curator) return;
    curator.subscriptions = curator.subscriptions.filter(item => item.eventId !== String(eventId));
    await saveCurator(db, curator);
    await reply(db, chatId, 'Больше не слежу за этим мероприятием.', mainKeyboard(), callbackQueryId, log);
}

async function sendCount(db, chatId, eventId, log, callbackQueryId) {
    const snap = await db.collection('events').doc(String(eventId)).get();
    const title = snap.exists ? (snap.data().title || 'Мероприятие') : 'Мероприятие';
    const count = await confirmedCount(db, String(eventId));
    await reply(db, chatId, `${title}: записано ${count}.`, eventKeyboard(eventId, true), callbackQueryId, log);
}

async function sendAllSummary(db, chatId, log, callbackQueryId) {
    const events = await openEvents(db);
    if (!events.length) {
        await reply(db, chatId, 'Сейчас нет мероприятий с открытой записью.', mainKeyboard(), callbackQueryId, log);
        return;
    }
    const lines = ['Сводка по мероприятиям на записи', ''];
    for (const event of events) {
        const count = await confirmedCount(db, event.id);
        lines.push(`${event.title || 'Мероприятие'}: ${count}`);
    }
    await reply(db, chatId, lines.join('\n'), mainKeyboard(), callbackQueryId, log);
}

async function sendMySubscriptions(db, chatId, log, callbackQueryId) {
    const curator = await loadCurator(db, chatId);
    const subs = (curator && curator.subscriptions) || [];
    if (!subs.length) {
        await reply(db, chatId, 'Вы ещё ни за чем не следите.', mainKeyboard(), callbackQueryId, log);
        return;
    }
    const lines = ['Ваши подписки', ''];
    const rows = [];
    for (const sub of subs) {
        const snap = await db.collection('events').doc(sub.eventId).get();
        const title = snap.exists ? (snap.data().title || sub.eventId) : sub.eventId;
        lines.push(`${title}: ${modeLabel(sub.mode)}`);
        rows.push([{ text: clip(title, 40), callback_data: `e:${sub.eventId}` }]);
    }
    rows.push([{ text: 'В меню', callback_data: 'menu' }]);
    await reply(db, chatId, lines.join('\n'), keyboard(rows), callbackQueryId, log);
}

async function handleCuratorUpdate(db, update, log = console) {
    const query = update.callback_query;
    const message = update.message;
    const from = (query && query.from) || (message && message.from) || {};
    const chat = (query && query.message && query.message.chat) || (message && message.chat);
    if (!chat || chat.type === 'channel') return;
    const chatId = String(chat.id);
    const callbackQueryId = query && query.id ? String(query.id) : '';
    const command = String((message && message.text) || '').trim();
    const data = String((query && query.data) || '');

    const { curator, created } = await ensurePending(db, chatId, from);
    if (curator.status !== 'approved') {
        const text = created
            ? 'Запрос на доступ отправлен. Когда вас подтвердят в админке, снова напишите /start.'
            : 'Доступ ещё не подтвердили. Когда это сделают, напишите /start.';
        await reply(db, chatId, text, null, callbackQueryId, log);
        return;
    }

    if (command === '/start' || data === 'menu') {
        await sendMainMenu(db, chatId, log, callbackQueryId);
        return;
    }
    if (data === 'l') {
        await sendEventList(db, chatId, log, callbackQueryId);
        return;
    }
    if (data === 'a') {
        await sendAllSummary(db, chatId, log, callbackQueryId);
        return;
    }
    if (data === 's') {
        await sendMySubscriptions(db, chatId, log, callbackQueryId);
        return;
    }
    if (data.startsWith('e:')) {
        await sendEventMenu(db, chatId, data.slice(2), log, callbackQueryId);
        return;
    }
    if (data.startsWith('c:')) {
        await sendCount(db, chatId, data.slice(2), log, callbackQueryId);
        return;
    }
    if (data.startsWith('x:')) {
        await clearMode(db, chatId, data.slice(2), log, callbackQueryId);
        return;
    }
    if (data.startsWith('m:')) {
        const parts = data.split(':');
        const mode = parts[1] === 'i' ? 'instant' : (parts[1] === 'd' ? 'daily' : 'interval');
        await setMode(db, chatId, parts.slice(2).join(':'), mode, log, callbackQueryId);
        return;
    }
    await sendMainMenu(db, chatId, log, callbackQueryId);
}

async function listInstantChatIds(db, eventId) {
    const snap = await db.collection('telegramCurators').where('status', '==', 'approved').get();
    const ids = [];
    snap.docs.forEach(doc => {
        const data = doc.data() || {};
        const hit = (data.subscriptions || []).some(item => item.eventId === String(eventId) && item.mode === 'instant');
        if (hit) ids.push(String(data.chatId || doc.id));
    });
    return ids;
}

function formatDigest(title, count, newcomers) {
    const lines = [
        `Сводка: ${title}`,
        `Записано: ${count}`
    ];
    if (!newcomers.length) {
        lines.push('Новых с прошлой сводки нет.');
    } else {
        lines.push('', 'Новые:');
        newcomers.slice(0, 30).forEach(reg => lines.push(`• ${personName(reg)}`));
        if (newcomers.length > 30) lines.push(`и ещё ${newcomers.length - 30}`);
    }
    return lines.join('\n');
}

async function runTelegramDigests(db, log = console) {
    const settingsSnap = await db.collection('settings').doc('notifications').get();
    if (settingsSnap.exists && settingsSnap.data().telegramEnabled === false) return;
    const now = Date.now();
    const snap = await db.collection('telegramCurators').where('status', '==', 'approved').get();
    for (const doc of snap.docs) {
        const curator = {
            ...(doc.data() || {}),
            chatId: String((doc.data() || {}).chatId || doc.id),
            subscriptions: Array.isArray((doc.data() || {}).subscriptions) ? doc.data().subscriptions : []
        };
        let changed = false;
        for (const sub of curator.subscriptions) {
            if (!digestDue(sub.mode, sub.lastDigestAt, now)) continue;
            const eventSnap = await db.collection('events').doc(String(sub.eventId)).get();
            if (!eventSnap.exists || !isOpenEvent({ ...eventSnap.data(), id: eventSnap.id })) continue;
            const since = Number(sub.lastDigestAt) || 0;
            const newcomers = since ? await newRegistrationsSince(db, sub.eventId, since) : [];
            const count = await confirmedCount(db, sub.eventId);
            const text = formatDigest(eventSnap.data().title || 'Мероприятие', count, newcomers);
            const sent = await relayTelegram(db, { chatIds: [curator.chatId], text }, log);
            if (sent) {
                sub.lastDigestAt = now;
                changed = true;
            }
        }
        if (changed) await saveCurator(db, curator);
    }
}

async function notifyCuratorApproved(db, chatId, log = console) {
    await sendMainMenu(db, chatId, log, '');
}

module.exports = {
    digestDue,
    dailySlotStartMs,
    handleCuratorUpdate,
    listInstantChatIds,
    runTelegramDigests,
    notifyCuratorApproved,
    formatDigest
};
