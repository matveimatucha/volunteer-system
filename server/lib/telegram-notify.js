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

async function sendTelegramMessage(token, chatId, text) {
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

async function sendRegistrationNotification(db, registration, regId, log = console) {
    const token = getBotToken();
    if (!token) return false;

    if (registration.telegramNotifiedAt) return false;

    const chatIds = await getRecipientChatIds(db);
    if (!chatIds.length) {
        log.warn('[telegram] нет получателей — задайте TELEGRAM_CHAT_IDS или chat ID в админке');
        return false;
    }

    const text = formatRegistrationMessage(registration, regId);
    const results = await Promise.allSettled(
        chatIds.map(chatId => sendTelegramMessage(token, chatId, text))
    );

    const delivered = results.filter(r => r.status === 'fulfilled').length;
    if (!delivered) {
        const firstErr = results.find(r => r.status === 'rejected');
        throw firstErr ? firstErr.reason : new Error('delivery failed');
    }

    await db.collection('registrations').doc(regId).update({
        telegramNotifiedAt: Date.now()
    }).catch(() => {});

    log.info(`[telegram] отправлено ${delivered}/${chatIds.length} получателям`, { regId });
    return true;
}

function scheduleRegistrationTelegram(db, regId, registration, log = console) {
    if (!getBotToken()) return;
    sendRegistrationNotification(db, registration, regId, log).catch((err) => {
        log.error('[telegram] ошибка отправки', { regId, error: err.message });
    });
}

function getWebhookSecret() {
    return (process.env.TELEGRAM_WEBHOOK_SECRET || '').trim();
}

function getPublicSiteUrl() {
    return (process.env.PUBLIC_SITE_URL || 'https://volonter-msu.ru').replace(/\/$/, '');
}

async function handleTelegramUpdate(update, log = console) {
    const token = getBotToken();
    if (!token || !update) return;

    const message = update.message || update.edited_message;
    if (!message || !message.chat) return;

    const text = String(message.text || '').trim().toLowerCase();
    const chatId = message.chat.id;
    if (!text.startsWith('/start') && text !== '/id') return;

    const reply = [
        '✅ Бот подключён к системе регистрации Профкома МГУ.',
        '',
        `Ваш chat_id: ${chatId}`,
        '',
        'Скопируйте это число и добавьте в админке:',
        'volonter-msu.ru/admin.html → раздел «Telegram» → + Добавить',
        '',
        'После этого вы будете получать уведомления о новых заявках.'
    ].join('\n');

    await sendTelegramMessage(token, chatId, reply);
    log.info('[telegram] ответ на /start', { chatId });
}

async function ensureTelegramWebhook(log = console) {
    const token = getBotToken();
    if (!token) return;

    const webhookUrl = `${getPublicSiteUrl()}/api/telegram/webhook`;
    const secret = getWebhookSecret();
    const payload = { url: webhookUrl, allowed_updates: ['message'] };
    if (secret) payload.secret_token = secret;

    const response = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });

    if (!response.ok) {
        const body = await response.text().catch(() => '');
        log.error('[telegram] не удалось зарегистрировать webhook', body.slice(0, 200));
        return;
    }

    const json = await response.json();
    if (json.ok) {
        log.info('[telegram] webhook зарегистрирован', { url: webhookUrl });
    } else {
        log.error('[telegram] setWebhook error', json.description || json);
    }
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
    getWebhookSecret,
    getRecipientChatIds,
    formatRegistrationMessage,
    sendTelegramMessage,
    sendRegistrationNotification,
    scheduleRegistrationTelegram,
    handleTelegramUpdate,
    ensureTelegramWebhook,
    startRegistrationWatcher
};
