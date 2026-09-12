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

function isFirstNameQuestion(q) {
    const s = String(q || '').toLowerCase().trim();
    if (!s || s.includes('фамил') || s.includes('отчест')) return false;
    return s === 'имя'
        || s.startsWith('имя ')
        || s.endsWith(' имя')
        || s.includes('ваше имя')
        || s === 'name'
        || s.startsWith('first name');
}

const RU_MONTHS = {
    'января': 0, 'февраля': 1, 'марта': 2, 'апреля': 3, 'мая': 4, 'июня': 5,
    'июля': 6, 'августа': 7, 'сентября': 8, 'октября': 9, 'ноября': 10, 'декабря': 11,
    'янв': 0, 'фев': 1, 'мар': 2, 'апр': 3, 'май': 4, 'июн': 5,
    'июл': 6, 'авг': 7, 'сен': 8, 'окт': 9, 'ноя': 10, 'дек': 11
};

const MAX_EVENT_DAYS = 62;
const SELECTED_DAYS_LABEL = 'Дни участия';
const DISPLAY_MONTHS_SHORT = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
const DISPLAY_WEEKDAYS = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];

function parseEventDateValue(dateStr) {
    if (!dateStr || !String(dateStr).trim()) return null;
    const raw = String(dateStr).trim().replace(/\s*г\.?\s*$/i, '').trim();

    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
        const [year, month, day] = raw.split('-').map(Number);
        return new Date(year, month - 1, day);
    }

    const dotted = raw.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
    if (dotted) {
        return new Date(Number(dotted[3]), Number(dotted[2]) - 1, Number(dotted[1]));
    }

    const ruMatch = raw.toLowerCase().match(/(\d{1,2})\s+([а-яё]+)\s+(\d{4})/);
    if (ruMatch && RU_MONTHS[ruMatch[2]] != null) {
        return new Date(Number(ruMatch[3]), RU_MONTHS[ruMatch[2]], Number(ruMatch[1]));
    }

    const parsed = new Date(raw);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function pad2(n) {
    return String(n).padStart(2, '0');
}

function toIsoDate(date) {
    if (!date) return '';
    return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function getEventDate(event) {
    return parseEventDateValue(event && (event.dateRaw || event.date));
}

function getEventEndDate(event) {
    return parseEventDateValue(event && (event.dateEndRaw || event.dateEnd)) || getEventDate(event);
}

function isMultiDayEvent(event) {
    const start = getEventDate(event);
    const end = getEventEndDate(event);
    return !!(start && end && end.getTime() > start.getTime());
}

function enumerateEventDays(event) {
    const start = getEventDate(event);
    if (!start) return [];
    const end = getEventEndDate(event) || start;
    const last = end.getTime() >= start.getTime() ? end : start;
    const days = [];
    const cur = new Date(start.getFullYear(), start.getMonth(), start.getDate());
    const lastDay = new Date(last.getFullYear(), last.getMonth(), last.getDate());
    for (let i = 0; i < MAX_EVENT_DAYS; i++) {
        days.push(toIsoDate(cur));
        if (cur.getTime() >= lastDay.getTime()) break;
        cur.setDate(cur.getDate() + 1);
    }
    return days;
}

function formatEventDayChip(isoDate) {
    const date = parseEventDateValue(isoDate);
    if (!date) return String(isoDate || '');
    return `${DISPLAY_WEEKDAYS[date.getDay()]}, ${date.getDate()} ${DISPLAY_MONTHS_SHORT[date.getMonth()]}`;
}

function formatSelectedDaysDisplay(days) {
    if (!Array.isArray(days) || !days.length) return '';
    return days.map((iso) => formatEventDayChip(iso)).join(', ');
}

function sanitizeSelectedDays(raw, event) {
    const allowed = new Set(enumerateEventDays(event));
    const input = Array.isArray(raw)
        ? raw
        : (typeof raw === 'string' && raw ? raw.split(/[,;]/) : []);
    const unique = [];
    const seen = new Set();
    for (const item of input) {
        const iso = String(item || '').trim();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(iso) || !allowed.has(iso) || seen.has(iso)) continue;
        seen.add(iso);
        unique.push(iso);
    }
    unique.sort();
    return unique;
}

function withSelectedDaysLabeled(answersLabeled, selectedDays) {
    const list = Array.isArray(answersLabeled)
        ? answersLabeled.filter((item) => item && item.question !== SELECTED_DAYS_LABEL)
        : [];
    if (Array.isArray(selectedDays) && selectedDays.length) {
        list.unshift({
            question: SELECTED_DAYS_LABEL,
            answer: formatSelectedDaysDisplay(selectedDays)
        });
    }
    return list;
}

function isEventDatePassed(event, now = new Date()) {
    const date = getEventEndDate(event) || getEventDate(event);
    if (!date) return false;
    const day = new Date(date);
    day.setHours(0, 0, 0, 0);
    const today = new Date(now);
    today.setHours(0, 0, 0, 0);
    return day < today;
}

/** Мероприятие закрыто для регистрации (черновик, шаблон, архив, прошедшая дата или статус closed). */
function isEventClosedForRegistration(event) {
    const status = (event && event.status) || 'open';
    return status === 'closed'
        || status === 'draft'
        || event.isTemplate === true
        || event.isArchived === true
        || isEventDatePassed(event);
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
        if (!fields.firstName && isFirstNameQuestion(q)) fields.firstName = a;
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
    SELECTED_DAYS_LABEL,
    MAX_EVENT_DAYS,
    normalizeEmail,
    normalizePhone,
    findContactEmail,
    findContactPhone,
    getRegistrationStatus,
    isConfirmedRegistration,
    isFirstNameQuestion,
    parseEventDateValue,
    getEventDate,
    getEventEndDate,
    isMultiDayEvent,
    enumerateEventDays,
    formatSelectedDaysDisplay,
    sanitizeSelectedDays,
    withSelectedDaysLabeled,
    isEventDatePassed,
    isEventClosedForRegistration,
    isEventHidden,
    extractCommonFields,
    normalizeAnswers,
    formatAnswersList,
    buildSheetsRegisterPayload,
    buildSheetsBulkRow
};
