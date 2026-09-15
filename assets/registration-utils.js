/**
 * Сбор и нормализация ответов анкеты регистрации.
 */
const REGISTRATION_STATUS = {
    CONFIRMED: 'confirmed',
    WAITLIST: 'waitlist',
    CANCELLED: 'cancelled'
};

function escapeHtmlText(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function escapeHtmlAttr(value) {
    return escapeHtmlText(value).replace(/'/g, '&#39;');
}

/** Значение ячейки таблицы: массивы (multiselect), объекты → строка. */
function formatDisplayValue(value) {
    if (value == null || value === '') return '';
    if (Array.isArray(value)) return value.map(formatDisplayValue).filter(Boolean).join(', ');
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
}

function isAnswerableQuestion(q) {
    return q && q.id != null && q.type !== 'infotext';
}

function buildQuestionTextMap(questions) {
    const map = {
        name: 'Имя',
        email: 'Email',
        phone: 'Телефон'
    };
    (questions || []).forEach((q) => {
        if (isAnswerableQuestion(q)) {
            map[`question_${q.id}`] = q.text || `Вопрос ${q.id}`;
        }
    });
    return map;
}

/** Ключи ответов в порядке вопросов формы; неизвестные ключи — в конце. */
function getOrderedAnswerKeys(questions, records) {
    const keys = [];
    const seen = new Set();
    (questions || []).forEach((q) => {
        if (isAnswerableQuestion(q)) {
            const key = `question_${q.id}`;
            keys.push(key);
            seen.add(key);
        }
    });
    const extras = new Set();
    (records || []).forEach((r) => {
        if (!r.answers || typeof r.answers !== 'object' || Array.isArray(r.answers)) return;
        Object.keys(r.answers).forEach((k) => {
            if (!seen.has(k)) extras.add(k);
        });
    });
    return keys.concat(Array.from(extras).sort());
}

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
        const key = `question_${q.id}`;
        const normalized = normalizeEmail(answers[key]);
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

    if (answers?.phone) {
        const normalized = normalizePhone(answers.phone);
        if (normalized) return normalized;
    }

    return '';
}

function getRegistrationStatus(record) {
    return record?.status || REGISTRATION_STATUS.CONFIRMED;
}

function isConfirmedRegistration(record) {
    return getRegistrationStatus(record) === REGISTRATION_STATUS.CONFIRMED;
}

function isCancelledRegistration(record) {
    return getRegistrationStatus(record) === REGISTRATION_STATUS.CANCELLED;
}

const GRID_ROW_SEP = ' — ';
const GRID_SLOT_SEP = ', ';
const GRID_LINE_SEP = '; ';
const DEFAULT_GRID_COLUMNS = ['8:00-12:00', '12:00-16:00', '16:00-20:00', 'Не смогу в этот день'];
const GRID_MONTHS_LONG = [
    'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
    'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'
];
const GRID_WEEKDAYS_LONG = [
    'воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'
];

function isGridRowFieldName(key) {
    return /^question_.+__\d+$/.test(String(key || ''));
}

function formatGridRowLabel(isoDate) {
    const date = parseEventDateValue(isoDate);
    if (!date) return String(isoDate || '');
    return `${date.getDate()} ${GRID_MONTHS_LONG[date.getMonth()]}, ${GRID_WEEKDAYS_LONG[date.getDay()]}`;
}

function formatGridAnswer(question, selectedByRow) {
    const rows = Array.isArray(question?.rows) ? question.rows : [];
    const parts = [];
    rows.forEach((row, ri) => {
        const label = String(row || '').trim();
        const values = (selectedByRow[ri] || [])
            .map((value) => String(value || '').trim())
            .filter(Boolean);
        if (!label || !values.length) return;
        parts.push(`${label}${GRID_ROW_SEP}${values.join(GRID_SLOT_SEP)}`);
    });
    return parts.join(GRID_LINE_SEP);
}

function formatGridAnswerFromForm(form, question) {
    const fieldName = `question_${question.id}`;
    const rows = Array.isArray(question.rows) ? question.rows : [];
    const selectedByRow = rows.map((_, ri) => {
        const checked = form.querySelectorAll(`input[name="${fieldName}__${ri}"]:checked`);
        return Array.from(checked).map((cb) => cb.value);
    });
    return formatGridAnswer(question, selectedByRow);
}

function collectAnswersFromForm(form, questions) {
    const formData = new FormData(form);
    const answers = {};

    // Collect entries, joining multiple checkbox values (multiselect) with ", "
    const rawEntries = {};
    for (const [key, value] of formData.entries()) {
        if (key === 'registrationMode' || key === 'selectedDays') continue;
        if (isGridRowFieldName(key)) continue;
        const v = typeof value === 'string' ? value.trim() : value;
        if (rawEntries[key] !== undefined) {
            if (!Array.isArray(rawEntries[key])) rawEntries[key] = [rawEntries[key]];
            rawEntries[key].push(v);
        } else {
            rawEntries[key] = v;
        }
    }
    for (const [key, val] of Object.entries(rawEntries)) {
        answers[key] = Array.isArray(val) ? val.join(', ') : val;
    }

    (questions || []).forEach((q) => {
        if (!q || q.type !== 'grid' || q.id == null) return;
        const formatted = formatGridAnswerFromForm(form, q);
        const key = `question_${q.id}`;
        if (formatted) answers[key] = formatted;
        else delete answers[key];
    });

    const questionTextMap = buildQuestionTextMap(questions);

    // Build an ORDERED array [{question, answer}] following the questions array order
    const usedKeys = new Set();
    const answersLabeled = [];

    const orderedKeys = (questions && questions.length > 0)
        ? questions.filter(isAnswerableQuestion).map(q => `question_${q.id}`)
        : Object.keys(answers);

    for (const key of orderedKeys) {
        if (answers[key] !== undefined && answers[key] !== '') {
            answersLabeled.push({ question: questionTextMap[key] || key, answer: answers[key] });
            usedKeys.add(key);
        }
    }
    for (const [key, val] of Object.entries(answers)) {
        if (!usedKeys.has(key) && val !== '') {
            answersLabeled.push({ question: questionTextMap[key] || key, answer: val });
        }
    }

    const contactEmail = findContactEmail(answers, questions);
    const contactPhone = findContactPhone(answers, questions);

    return { answers, answersLabeled, contactEmail, contactPhone };
}

function formatAnswersForEmail(answersLabeled) {
    if (Array.isArray(answersLabeled)) {
        return answersLabeled.map(item => `${item.question}: ${item.answer}`).join('\n');
    }
    return Object.entries(answersLabeled || {})
        .map(([label, value]) => `${label}: ${value}`)
        .join('\n');
}

function formatDateRuFromIso(isoDate) {
    if (!isoDate || !/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) return isoDate || '';
    const [year, month, day] = isoDate.split('-').map(Number);
    return new Date(year, month - 1, day).toLocaleDateString('ru-RU', {
        day: 'numeric',
        month: 'long',
        year: 'numeric'
    });
}

const DISPLAY_MONTHS = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];

/**
 * Нормализует дату мероприятия в единый формат «15 мар 2025».
 * Принимает любой формат, который понимает parseEventDateValue.
 * Если разобрать не удалось — возвращает строку как есть.
 */
function formatEventDisplayDate(dateStr) {
    if (!dateStr) return '';
    const date = parseEventDateValue(String(dateStr));
    if (!date) return String(dateStr);
    return `${date.getDate()} ${DISPLAY_MONTHS[date.getMonth()]} ${date.getFullYear()}`;
}

const RU_MONTHS = {
    'января': 0, 'февраля': 1, 'марта': 2, 'апреля': 3, 'мая': 4, 'июня': 5,
    'июля': 6, 'августа': 7, 'сентября': 8, 'октября': 9, 'ноября': 10, 'декабря': 11,
    'янв': 0, 'фев': 1, 'мар': 2, 'апр': 3, 'май': 4, 'июн': 5,
    'июл': 6, 'авг': 7, 'сен': 8, 'окт': 9, 'ноя': 10, 'дек': 11
};

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

const MAX_EVENT_DAYS = 62;
const SELECTED_DAYS_LABEL = 'Дни участия';
const DISPLAY_WEEKDAYS = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];

function toIsoDate(date) {
    if (!date) return '';
    return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function getEventDate(event) {
    return parseEventDateValue(event?.dateRaw || event?.date);
}

function getEventEndDate(event) {
    return parseEventDateValue(event?.dateEndRaw || event?.dateEnd) || getEventDate(event);
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

function formatEventDateRange(event) {
    if (!event) return '';
    const start = getEventDate(event);
    if (!start) return String(event.date || event.dateRaw || '');
    const end = getEventEndDate(event);
    if (!end || end.getTime() <= start.getTime()) {
        return formatEventDisplayDate(toIsoDate(start));
    }
    const sameYear = start.getFullYear() === end.getFullYear();
    const sameMonth = sameYear && start.getMonth() === end.getMonth();
    if (sameMonth) {
        return `${start.getDate()}–${end.getDate()} ${DISPLAY_MONTHS[end.getMonth()]} ${end.getFullYear()}`;
    }
    const startPart = sameYear
        ? `${start.getDate()} ${DISPLAY_MONTHS[start.getMonth()]}`
        : `${start.getDate()} ${DISPLAY_MONTHS[start.getMonth()]} ${start.getFullYear()}`;
    return `${startPart} — ${end.getDate()} ${DISPLAY_MONTHS[end.getMonth()]} ${end.getFullYear()}`;
}

function formatEventDayChip(isoDate) {
    const date = parseEventDateValue(isoDate);
    if (!date) return String(isoDate || '');
    return `${DISPLAY_WEEKDAYS[date.getDay()]}, ${date.getDate()} ${DISPLAY_MONTHS[date.getMonth()]}`;
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

function registrationHasDay(record, iso) {
    if (!iso) return true;
    const days = Array.isArray(record?.selectedDays) ? record.selectedDays : [];
    if (!days.length) return true;
    return days.includes(iso);
}

function isEventArchived(event, today) {
    if (event?.isArchived) return true;
    const eventDate = getEventEndDate(event) || getEventDate(event);
    if (!eventDate) return false;
    const day = new Date(eventDate);
    day.setHours(0, 0, 0, 0);
    return day < today;
}

function getDefaultEventTodos(baseId) {
    const base = Number(baseId) || Date.now();
    return [
        { id: base + 1, phase: 'before', text: 'Заполнить описание, фото и форму регистрации', done: false },
        { id: base + 2, phase: 'before', text: 'Открыть регистрацию (статус «Открыто»)', done: false },
        { id: base + 3, phase: 'before', text: 'Скинуть ссылку на форму волонтёрам', done: false },
        { id: base + 4, phase: 'before', text: 'Напомнить участникам накануне', done: false },
        { id: base + 5, phase: 'after', text: 'Отметить явку участников', done: false },
        { id: base + 6, phase: 'after', text: 'Проставить часы работы', done: false },
        { id: base + 7, phase: 'after', text: 'Добавить фото и текст итогов', done: false },
        { id: base + 8, phase: 'after', text: 'Выгрузить заявки или синхронизировать таблицу', done: false },
        { id: base + 9, phase: 'after', text: 'Закрыть регистрацию', done: false }
    ];
}

function normalizeEventTodos(raw) {
    if (!Array.isArray(raw)) return [];
    return raw.slice(0, 40).map((item, index) => {
        if (!item || typeof item !== 'object') return null;
        const text = String(item.text || '').trim().slice(0, 300);
        if (!text) return null;
        return {
            id: item.id != null ? item.id : Date.now() + index,
            text,
            phase: item.phase === 'after' ? 'after' : 'before',
            done: item.done === true
        };
    }).filter(Boolean);
}

function getEventTodos(event) {
    const todos = normalizeEventTodos(event && event.todos);
    return todos.length ? todos : getDefaultEventTodos(event && event.id);
}

function canArchiveEvent(event) {
    if (!event || event.isTemplate === true) return false;
    const after = getEventTodos(event).filter((item) => item.phase === 'after');
    return after.length > 0 && after.every((item) => item.done === true);
}

function pad2(n) {
    return String(n).padStart(2, '0');
}

function formatIcsDate(date) {
    return `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}`;
}

function escapeIcsText(value) {
    return String(value ?? '')
        .replace(/\\/g, '\\\\')
        .replace(/;/g, '\\;')
        .replace(/,/g, '\\,')
        .replace(/\r?\n/g, '\\n');
}

/**
 * Возвращает ссылки на добавление события в календарь.
 * Событие считается «на весь день» (есть только дата, без времени).
 */
function buildCalendarLinks(event) {
    const date = getEventDate(event);
    if (!date) return null;

    const start = new Date(date);
    start.setHours(0, 0, 0, 0);
    const last = getEventEndDate(event) || start;
    const end = new Date(last);
    end.setHours(0, 0, 0, 0);
    end.setDate(end.getDate() + 1);

    const title = event?.title || 'Волонтёрское мероприятие';
    const location = event?.location || '';
    const details = event?.description || '';

    const gStart = formatIcsDate(start);
    const gEnd = formatIcsDate(end);
    const googleUrl = 'https://calendar.google.com/calendar/render?action=TEMPLATE'
        + `&text=${encodeURIComponent(title)}`
        + `&dates=${gStart}/${gEnd}`
        + `&details=${encodeURIComponent(details)}`
        + `&location=${encodeURIComponent(location)}`;

    const ics = [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'PRODID:-//volunteer-system//RU',
        'CALSCALE:GREGORIAN',
        'BEGIN:VEVENT',
        `UID:${(event?.id || 'event')}-${Date.now()}@volunteer-system`,
        `DTSTAMP:${formatIcsDate(new Date())}T000000Z`,
        `DTSTART;VALUE=DATE:${gStart}`,
        `DTEND;VALUE=DATE:${gEnd}`,
        `SUMMARY:${escapeIcsText(title)}`,
        `DESCRIPTION:${escapeIcsText(details)}`,
        `LOCATION:${escapeIcsText(location)}`,
        'END:VEVENT',
        'END:VCALENDAR'
    ].join('\r\n');

    return { googleUrl, ics };
}

function isValidVkUrl(url) {
    if (!url || typeof url !== 'string') return false;
    try {
        const u = new URL(url.trim());
        if (u.protocol !== 'https:') return false;
        const host = u.hostname.toLowerCase();
        return host === 'vk.com' || host === 'www.vk.com' || host === 'm.vk.com'
            || host === 'vk.ru' || host === 'www.vk.ru' || host === 'm.vk.ru';
    } catch {
        return false;
    }
}

function getBaseTemplateQuestions() {
    const baseId = Date.now();
    return [
        { id: baseId,     text: 'Фамилия',  type: 'text', required: true,  description: 'Ваша фамилия', options: [] },
        { id: baseId + 1, text: 'Имя',      type: 'text', required: true,  description: 'Ваше имя', options: [] },
        { id: baseId + 2, text: 'Отчество', type: 'text', required: false, description: 'Если есть', options: [] },
        { id: baseId + 3, text: 'Факультет', type: 'faculty', required: true, description: 'Выберите ваш факультет из списка', options: [] },
        { id: baseId + 4, text: 'Курс обучения', type: 'course', required: true, description: 'Укажите на каком курсе вы учитесь', options: [] },
        { id: baseId + 5, text: 'ВКонтакте', type: 'vk', required: true, description: 'Пример: https://vk.com/your_id или https://vk.ru/your_id', options: [] },
        { id: baseId + 6, text: 'Telegram', type: 'telegram', required: true, description: 'Начинается с @, например: @username', options: [] },
        { id: baseId + 7, text: 'Номер телефона', type: 'tel', required: true, description: 'Для срочной связи', options: [] },
        { id: baseId + 8, text: 'Размер футболки', type: 'select', required: true, description: 'Нужно для заказа формы', options: ['XS', 'S', 'M', 'L', 'XL', 'XXL'] },
        { id: baseId + 9, text: 'Опыт волонтёрства', type: 'textarea', required: false, description: 'Расскажите где и когда вы были волонтёром (если был опыт)', options: [] },
        {
            id: baseId + 10,
            text: 'Согласие на обработку персональных данных',
            type: 'checkbox',
            required: true,
            description: 'Даю согласие на обработку персональных данных для организации волонтёрского мероприятия',
            options: []
        }
    ];
}
