const {
    extractCommonFields,
    normalizeAnswers
} = require('./registration-helpers');

function getBotToken() {
    return (process.env.TELEGRAM_BOT_TOKEN || '').trim();
}

function parseChatIds(raw) {
    if (!raw) return [];
    if (Array.isArray(raw)) {
        return raw.map(id => String(id).trim()).filter(Boolean);
    }
    return String(raw).split(',').map(id => id.trim()).filter(Boolean);
}

async function getRecipientChatIds(db) {
    const fromEnv = parseChatIds(process.env.TELEGRAM_CHAT_IDS);
    if (!db) return [...new Set(fromEnv)];

    try {
        const snap = await db.collection('settings').doc('notifications').get();
        const data = snap.data() || {};
        if (data.telegramEnabled === false) return [];
        const fromDb = parseChatIds(data.telegramChatIds);
        return [...new Set([...fromEnv, ...fromDb])];
    } catch (_) {
        return [...new Set(fromEnv)];
    }
}

function statusLabel(status) {
    if (status === 'waitlist') return 'лист ожидания';
    if (status === 'cancelled') return 'отменена';
    return 'подтверждена';
}

function formatRegistrationMessage(registration, regId) {
    const common = extractCommonFields(registration.answersLabeled);
    const lines = [
        '🆕 Новая регистрация',
        '',
        `Мероприятие: ${registration.eventTitle || '—'}`,
        `Статус: ${statusLabel(registration.status)}`
    ];

    if (common.name) lines.push(`Имя: ${common.name}`);
    if (registration.contactEmail) lines.push(`Email: ${registration.contactEmail}`);
    if (registration.contactPhone) lines.push(`Телефон: ${registration.contactPhone}`);
    if (common.faculty) lines.push(`Факультет: ${common.faculty}`);
    if (common.year) lines.push(`Курс: ${common.year}`);

    for (const item of normalizeAnswers(registration.answersLabeled)) {
        const q = String(item.question || '').toLowerCase();
        if (q.includes('telegram') || q.includes('телеграм')) {
            lines.push(`Telegram: ${item.answer}`);
            break;
        }
    }

    const answers = normalizeAnswers(registration.answersLabeled)
        .filter(item => item.answer !== '' && item.answer != null)
        .slice(0, 15);

    if (answers.length) {
        lines.push('', 'Ответы:');
        for (const item of answers) {
            lines.push(`• ${item.question}: ${item.answer}`);
        }
    }

    lines.push('', `ID: ${regId}`);
    if (registration.timestamp) lines.push(`Время: ${registration.timestamp}`);

    let text = lines.join('\n');
    if (text.length > 4000) text = text.slice(0, 3990) + '\n…';
    return text;
}

const { resolveSheetsUrl, postToSheets } = require('./sheets-sync');

async function sendTelegramDirect(token, chatId, text) {
    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            chat_id: chatId,
            text,
            disable_web_page_preview: true
        })
    });

    if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(`HTTP ${response.status}${body ? `: ${body.slice(0, 200)}` : ''}`);
    }
    return true;
}

async function sendViaAppsScript(db, registration, regId, log) {
    const token = getBotToken();
    const chatIds = await getRecipientChatIds(db);
    if (!token || !chatIds.length) return false;

    const url = await resolveSheetsUrl(db);
    if (!url) {
        log.warn('[telegram] нет SHEETS_WEBHOOK_URL — задайте URL таблицы в админке');
        return false;
    }

    const text = formatRegistrationMessage(registration, regId);
    const ok = await postToSheets({
        action: 'telegram_notify',
        botToken: token,
        chatIds,
        text,
        regId
    }, db);

    if (ok) {
        log.info('[telegram] отправлено через Apps Script', { regId, recipients: chatIds.length });
    }
    return ok;
}

async function sendRegistrationNotification(db, registration, regId, log = console) {
    if (registration.telegramNotifiedAt) return false;

    const chatIds = await getRecipientChatIds(db);
    if (!chatIds.length) {
        log.warn('[telegram] нет получателей — добавьте chat ID в админке');
        return false;
    }

    if (!getBotToken()) {
        log.warn('[telegram] TELEGRAM_BOT_TOKEN не задан на сервере');
        return false;
    }

    // Основной путь: Google Apps Script (VPS в РФ не достучится до Telegram напрямую)
    let sent = await sendViaAppsScript(db, registration, regId, log);

    // Запасной путь: прямой API (если когда-нибудь заработает)
    if (!sent) {
        const text = formatRegistrationMessage(registration, regId);
        const token = getBotToken();
        const results = await Promise.allSettled(
            chatIds.map(chatId => sendTelegramDirect(token, chatId, text))
        );
        sent = results.some(r => r.status === 'fulfilled');
        if (sent) log.info('[telegram] отправлено напрямую', { regId });
    }

    if (!sent) return false;

    await db.collection('registrations').doc(regId).update({
        telegramNotifiedAt: Date.now()
    }).catch(() => {});

    return true;
}

function scheduleRegistrationTelegram(db, regId, registration, log = console) {
    if (!getBotToken()) return;
    sendRegistrationNotification(db, registration, regId, log).catch((err) => {
        log.error('[telegram] ошибка отправки', { regId, error: err.message });
    });
}

async function handleTelegramUpdate(update, log = console) {
    // Webhook с VPS не работает — ответ на /start тоже через Apps Script при необходимости
    log.info('[telegram] webhook update ignored (use @userinfobot for chat_id)');
}

async function ensureTelegramWebhook(log = console) {
    log.info('[telegram] webhook отключён — используется Apps Script relay');
}

function startRegistrationWatcher(db, log = console) {
    const token = getBotToken();
    if (!token) {
        log.info('[telegram] TELEGRAM_BOT_TOKEN не задан — уведомления отключены');
        return;
    }

    let ready = false;
    db.collection('registrations').onSnapshot(
        (snapshot) => {
            if (!ready) {
                ready = true;
                log.info('[telegram] слушатель новых регистраций запущен');
                return;
            }

            snapshot.docChanges().forEach((change) => {
                if (change.type !== 'added') return;
                const data = change.doc.data();
                if (data.telegramNotifiedAt) return;
                scheduleRegistrationTelegram(db, change.doc.id, data, log);
            });
        },
        (err) => log.error('[telegram] ошибка слушателя Firestore', err)
    );
}

module.exports = {
    getBotToken,
    getRecipientChatIds,
    formatRegistrationMessage,
    sendRegistrationNotification,
    scheduleRegistrationTelegram,
    handleTelegramUpdate,
    ensureTelegramWebhook,
    startRegistrationWatcher
};
