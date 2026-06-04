/**
 * Сбор и нормализация ответов анкеты регистрации.
 */
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

function collectAnswersFromForm(form, questions) {
    const formData = new FormData(form);
    const answers = {};

    for (const [key, value] of formData.entries()) {
        answers[key] = typeof value === 'string' ? value.trim() : value;
    }

    const questionTextMap = buildQuestionTextMap(questions);
    const answersLabeled = {};
    for (const [key, val] of Object.entries(answers)) {
        const label = questionTextMap[key] || key;
        answersLabeled[label] = val;
    }

    const contactEmail = findContactEmail(answers, questions);

    return { answers, answersLabeled, contactEmail };
}

function formatAnswersForEmail(answersLabeled) {
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

const RU_MONTHS = {
    'января': 0, 'февраля': 1, 'марта': 2, 'апреля': 3, 'мая': 4, 'июня': 5,
    'июля': 6, 'августа': 7, 'сентября': 8, 'октября': 9, 'ноября': 10, 'декабря': 11
};

/** Парсит дату мероприятия (ISO, ДД.ММ.ГГГГ, «12 декабря 2026»). null — дата не распознана. */
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

/** В архив: вручную или дата в прошлом (если дата не распознана — остаётся в актуальных). */
function isEventArchived(event, today) {
    if (event?.isArchived) return true;
    const eventDate = getEventDate(event);
    if (!eventDate) return false;
    const day = new Date(eventDate);
    day.setHours(0, 0, 0, 0);
    return day < today;
}
