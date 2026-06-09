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

function buildQuestionTextMap(questions) {
    const map = {
        name: 'Имя',
        email: 'Email',
        phone: 'Телефон'
    };
    (questions || []).forEach((q) => {
        if (q && q.id != null) {
            map[`question_${q.id}`] = q.text || `Вопрос ${q.id}`;
        }
    });
    return map;
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

function collectAnswersFromForm(form, questions) {
    const formData = new FormData(form);
    const answers = {};

    // Collect entries, joining multiple checkbox values (multiselect) with ", "
    const rawEntries = {};
    for (const [key, value] of formData.entries()) {
        if (key === 'registrationMode') continue;
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

    const questionTextMap = buildQuestionTextMap(questions);

    // Build an ORDERED array [{question, answer}] following the questions array order
    const usedKeys = new Set();
    const answersLabeled = [];

    const orderedKeys = (questions && questions.length > 0)
        ? questions.map(q => `question_${q.id}`)
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
    'июля': 6, 'августа': 7, 'сентября': 8, 'октября': 9, 'ноября': 10, 'декабря': 11
};

function parseEventDateValue(dateStr) {
    if (!dateStr || !String(dateStr).trim()) return null;
    const raw = String(dateStr).trim();

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

function getEventDate(event) {
    return parseEventDateValue(event?.dateRaw || event?.date);
}

function isEventArchived(event, today) {
    if (event?.isArchived) return true;
    const eventDate = getEventDate(event);
    if (!eventDate) return false;
    const day = new Date(eventDate);
    day.setHours(0, 0, 0, 0);
    return day < today;
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
    const end = new Date(start);
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

function getBaseTemplateQuestions() {
    const baseId = Date.now();
    return [
        { id: baseId,     text: 'Фамилия',  type: 'text', required: true,  description: 'Ваша фамилия', options: [] },
        { id: baseId + 1, text: 'Имя',      type: 'text', required: true,  description: 'Ваше имя', options: [] },
        { id: baseId + 2, text: 'Отчество', type: 'text', required: false, description: 'Если есть', options: [] },
        { id: baseId + 3, text: 'Факультет', type: 'faculty', required: true, description: 'Выберите ваш факультет из списка', options: [] },
        { id: baseId + 4, text: 'Курс обучения', type: 'course', required: true, description: 'Укажите на каком курсе вы учитесь', options: [] },
        { id: baseId + 5, text: 'ВКонтакте', type: 'vk', required: true, description: 'Пример: https://vk.com/your_id', options: [] },
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
