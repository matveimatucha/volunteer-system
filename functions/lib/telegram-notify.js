const {
    extractCommonFields,
    normalizeAnswers
} = require('./registration-helpers');

function parseChatIds(raw) {
    if (!raw) return [];
    if (Array.isArray(raw)) {
        return raw.map(id => String(id).trim()).filter(Boolean);
    }
    return String(raw).split(',').map(id => id.trim()).filter(Boolean);
}

async function getRecipientChatIds(db, envChatIds) {
    const fromEnv = parseChatIds(envChatIds);
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

async function sendRegistrationNotification(db, token, envChatIds, registration, regId, log) {
    if (!token) return false;
    if (registration.telegramNotifiedAt) return false;

    const chatIds = await getRecipientChatIds(db, envChatIds);
    if (!chatIds.length) {
        log.warn('[telegram] нет получателей');
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

    log.info(`[telegram] отправлено ${delivered}/${chatIds.length}`, { regId });
    return true;
}

module.exports = {
    getRecipientChatIds,
    formatRegistrationMessage,
    sendRegistrationNotification
};
