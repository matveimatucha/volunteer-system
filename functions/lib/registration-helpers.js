/**
 * Серверные копии утилит из assets/registration-utils.js (и бывшего sheets-sync.js).
 * Логика должна совпадать с клиентской, чтобы данные оставались согласованными.
 */

const REGISTRATION_STATUS = {
    CONFIRMED: 'confirmed',
    WAITLIST: 'waitlist',
    CANCELLED: 'cancelled'
};

function normalizeEmail(value) {
    if (typeof value !== 'string') return '';
    const trimmed = value.trim().toLowerCase();
    const pattern = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
    return pattern.test(trimmed) ? trimmed : '';
}

function normalizePhone(value) {
    if (value == null) return '';
    const digits = String(value).replace(/\D/g, '');
    if (digits.length === 11 && digits.startsWith('8')) return '7' + digits.slice(1);
    if (digits.length === 11 && digits.startsWith('7')) return digits;
    if (digits.length === 10) return '7' + digits;
    return digits.length >= 10 ? digits : '';
}

function findContactEmail(answers, questions) {
    const emailPattern = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;

    for (const q of questions || []) {
        if (q.type !== 'email') continue;
        const normalized = normalizeEmail(answers[`question_${q.id}`]);
        if (normalized) return normalized;
    }

    for (const value of Object.values(answers || {})) {
        if (typeof value === 'string' && emailPattern.test(value.trim())) {
            return value.trim().toLowerCase();
        }
    }

    return '';
}

function findContactPhone(answers, questions) {
    for (const q of questions || []) {
        if (q.type !== 'tel') continue;
        const normalized = normalizePhone(answers[`question_${q.id}`]);
        if (normalized) return normalized;
    }

    if (answers && answers.phone) {
        const normalized = normalizePhone(answers.phone);
        if (normalized) return normalized;
    }

    return '';
}

function getRegistrationStatus(record) {
    return (record && record.status) || REGISTRATION_STATUS.CONFIRMED;
}

function isConfirmedRegistration(record) {
    return getRegistrationStatus(record) === REGISTRATION_STATUS.CONFIRMED;
}

/** Мероприятие закрыто для регистрации (черновик, шаблон, архив или статус closed). */
function isEventClosedForRegistration(event) {
    const status = (event && event.status) || 'open';
    return status === 'closed'
        || status === 'draft'
        || event.isTemplate === true
        || event.isArchived === true;
}

/** Мероприятие не должно быть видно публично. */
function isEventHidden(event) {
    const status = (event && event.status) || 'open';
    return status === 'draft' || event.isTemplate === true;
}

/* ---------- Формат данных для Google Sheets (как в assets/sheets-sync.js) ---------- */

function normalizeAnswers(answersLabeled) {
    if (Array.isArray(answersLabeled)) return answersLabeled;
    if (answersLabeled && typeof answersLabeled === 'object') {
        return Object.entries(answersLabeled).map(([question, answer]) => ({ question, answer }));
    }
    return [];
}

function extractCommonFields(answersLabeled) {
    const fields = {
        name: '',
        firstName: '',
        lastName: '',
        middleName: '',
        faculty: '',
        year: ''
    };
    for (const item of normalizeAnswers(answersLabeled)) {
        const q = String(item.question || '').toLowerCase();
        const a = String(item.answer || '').trim();
        if (!a) continue;

        if (!fields.lastName && q.includes('фамил')) fields.lastName = a;
        if (!fields.firstName && (q.includes('имя') || q.includes('name'))) fields.firstName = a;
        if (!fields.middleName && q.includes('отчест')) fields.middleName = a;
        if (!fields.name && (q.includes('фио') || q.includes('ф.и.о'))) fields.name = a;
        if (!fields.faculty && (q.includes('факульт') || q.includes('школ') || q.includes('институт') || q.includes('кафедр') || q.includes('направлен'))) {
            fields.faculty = a;
        }
        if (!fields.year && (q.includes('курс') || q.includes('год об') || q.includes('учеб'))) {
            fields.year = a;
        }
    }

    if (!fields.name) {
        fields.name = [fields.lastName, fields.firstName, fields.middleName].filter(Boolean).join(' ').trim();
    }

    return fields;
}

function formatAnswersList(answersLabeled) {
    return normalizeAnswers(answersLabeled)
        .filter(item => item.answer !== '' && item.answer != null)
        .map(item => `${item.question}: ${item.answer}`)
        .join(' | ');
}

/** Payload action=register для Apps Script. */
function buildSheetsRegisterPayload(registration) {
    const common = extractCommonFields(registration.answersLabeled);
    return {
        action:         'register',
        id:             registration.registrationId || '',
        registeredAt:   registration.createdAt || new Date().toISOString(),
        createdAtMs:    Number(registration.createdAtMs) || Date.now(),
        eventName:      registration.eventTitle || '',
        name:           common.name,
        email:          registration.contactEmail || '',
        phone:          registration.contactPhone || '',
        faculty:        common.faculty,
        year:           common.year,
        status:         registration.status || REGISTRATION_STATUS.CONFIRMED,
        answers:        formatAnswersList(registration.answersLabeled),
        answersLabeled: registration.answersLabeled || []
    };
}

/** Одна запись для action=bulk_sync (формат из старого admin.html). */
function buildSheetsBulkRow(id, registration, eventTitleById) {
    const common = extractCommonFields(registration.answersLabeled);
    return {
        id,
        registeredAt:   registration.createdAt || '',
        createdAtMs:    Number(registration.createdAtMs) || 0,
        eventName:      registration.eventTitle || eventTitleById[registration.eventId] || registration.eventId || '',
        name:           common.name,
        email:          registration.contactEmail || '',
        phone:          registration.contactPhone || '',
        faculty:        common.faculty,
        year:           common.year,
        status:         registration.status || 'pending',
        cancelledAt:    registration.cancelledAt || '',
        answers:        formatAnswersList(registration.answersLabeled),
        answersLabeled: registration.answersLabeled || []
    };
}

module.exports = {
    REGISTRATION_STATUS,
    normalizeEmail,
    normalizePhone,
    findContactEmail,
    findContactPhone,
    getRegistrationStatus,
    isConfirmedRegistration,
    isEventClosedForRegistration,
    isEventHidden,
    extractCommonFields,
    normalizeAnswers,
    formatAnswersList,
    buildSheetsRegisterPayload,
    buildSheetsBulkRow
};
