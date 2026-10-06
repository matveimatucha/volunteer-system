const {
    extractCommonFields,
    normalizeAnswers
} = require('./registration-helpers');

function getBotToken() {
    return (process.env.TELEGRAM_BOT_TOKEN || '').trim();
}

async function resolveBotToken(db) {
    const fromEnv = getBotToken();
    if (fromEnv) return fromEnv;
    if (!db) return '';
    try {
        const snap = await db.collection('settings').doc('notifications').get();
        return String((snap.data() || {}).telegramBotToken || '').trim();
    } catch (_) {
        return '';
    }
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

function formatRegistrationMessage(registration, regId, hits) {
    const common = extractCommonFields(registration.answersLabeled);
    const lines = [
        '🆕 Новая регистрация',
        '',
        `Мероприятие: ${registration.eventTitle || '—'}`,
        `Статус: ${statusLabel(registration.status)}`
    ];

    if (Array.isArray(hits) && hits.length) {
        lines.push('', '⛔ Не брать');
        const reasons = [...new Set(hits.map(hit => String(hit.reason || '').trim()).filter(Boolean))];
        if (reasons.length) lines.push(reasons.join('\n'));
    }

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
const { findBlacklistHits } = require('./blacklist');

async function relayTelegram(db, options, log = console) {
    const chatIds = (options.chatIds || []).map(String).filter(Boolean);
    const text = String(options.text || '');
    if (!chatIds.length || !text) return false;
    const token = await resolveBotToken(db);
    if (!token) {
        log.warn('[telegram] токен бота не задан');
        return false;
    }
    const payload = {
        action: 'telegram_notify',
        botToken: token,
        chatIds,
        text
    };
    if (options.replyMarkup) payload.replyMarkup = options.replyMarkup;
    if (options.callbackQueryId) payload.callbackQueryId = options.callbackQueryId;

    try {
        const ok = await postToSheets(payload, db);
        if (ok) return true;
    } catch (err) {
        log.warn('[telegram] Apps Script не отправил сообщение', err.message);
    }

    try {
        const results = await Promise.allSettled(chatIds.map(chatId => sendTelegramDirect(token, chatId, text, options.replyMarkup)));
        return results.some(item => item.status === 'fulfilled');
    } catch (_) {
        return false;
    }
}

async function sendTelegramDirect(token, chatId, text, replyMarkup) {
    const body = {
        chat_id: chatId,
        text,
        disable_web_page_preview: true
    };
    if (replyMarkup) body.reply_markup = replyMarkup;
    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });

    if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(`HTTP ${response.status}${body ? `: ${body.slice(0, 200)}` : ''}`);
    }
    return true;
}

async function sendViaAppsScript(db, registration, regId, log, hits) {
    const token = await resolveBotToken(db);
    const chatIds = await getRecipientChatIds(db);
    if (!token || !chatIds.length) return false;

    const url = await resolveSheetsUrl(db);
    if (!url) {
        log.warn('[telegram] нет SHEETS_WEBHOOK_URL — задайте URL таблицы в админке');
        return false;
    }

    const text = formatRegistrationMessage(registration, regId, hits);
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

async function claimTelegramNotification(db, regId) {
    const ref = db.collection('registrations').doc(regId);
    try {
        return await db.runTransaction(async (tx) => {
            const snap = await tx.get(ref);
            if (!snap.exists) return false;
            if (snap.data().telegramNotifiedAt) return false;
            tx.update(ref, { telegramNotifiedAt: Date.now() });
            return true;
        });
    } catch (_) {
        return false;
    }
}

async function sendRegistrationNotification(db, registration, regId, log = console) {
    if (registration.telegramNotifiedAt) return false;

    const claimed = await claimTelegramNotification(db, regId);
    if (!claimed) return false;

    const releaseClaim = () => db.collection('registrations').doc(regId).update({
        telegramNotifiedAt: null
    }).catch(() => {});

    try {
        const settingsSnap = await db.collection('settings').doc('notifications').get();
        if (settingsSnap.exists && settingsSnap.data().telegramEnabled === false) return true;

        const chatIds = await getRecipientChatIds(db);
        let instantIds = [];
        try {
            instantIds = await require('./telegram-bot').listInstantChatIds(db, registration.eventId);
        } catch (err) {
            log.error('[telegram] не удалось прочитать подписки', err);
        }
        const targets = [...new Set([...chatIds, ...instantIds])];
        if (!targets.length) {
            return true;
        }

        const token = await resolveBotToken(db);
        if (!token) {
            log.warn('[telegram] TELEGRAM_BOT_TOKEN не задан на сервере');
            await releaseClaim();
            return false;
        }

        let hits = [];
        try {
            const snap = await db.collection('blacklist').get();
            const entries = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
            hits = findBlacklistHits(entries, registration);
        } catch (err) {
            log.error('[blacklist] не удалось проверить список', err);
        }

        let sent = await relayTelegram(db, { chatIds: targets, text: formatRegistrationMessage(registration, regId, hits) }, log);

        if (!sent) {
            await releaseClaim();
            return false;
        }

        return true;
    } catch (err) {
        await releaseClaim();
        throw err;
    }
}

function scheduleRegistrationTelegram(db, regId, registration, log = console) {
    sendRegistrationNotification(db, registration, regId, log).catch((err) => {
        log.error('[telegram] ошибка отправки', { regId, error: err.message });
    });
}

async function handleTelegramUpdate(update, db, log = console) {
    if (!update || !db) return;
    await require('./telegram-bot').handleCuratorUpdate(db, update, log);
}

async function ensureTelegramWebhook(db, log = console) {
    const token = await resolveBotToken(db);
    if (!token) {
        log.info('[telegram] токен бота не задан — бот кураторов не запущен');
        return;
    }
    const base = (process.env.SITE_PUBLIC_URL || 'https://volunteer.msuprof.com').replace(/\/$/, '');
    const webhookUrl = `${base}/api/telegram/webhook`;
    const posted = await postToSheets({
        action: 'telegram_set_webhook',
        botToken: token,
        webhookUrl
    }, db);
    if (posted) {
        log.info('[telegram] запрос на webhook отправлен в Apps Script');
        return;
    }
    try {
        const response = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: webhookUrl })
        });
        if (response.ok) log.info('[telegram] webhook установлен напрямую');
        else log.warn('[telegram] не удалось установить webhook');
    } catch (err) {
        log.warn('[telegram] webhook не установлен', err.message);
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
    relayTelegram,
    resolveBotToken,
    getRecipientChatIds,
    formatRegistrationMessage,
    sendRegistrationNotification,
    scheduleRegistrationTelegram,
    handleTelegramUpdate,
    ensureTelegramWebhook,
    startRegistrationWatcher
};
