/* ================================================================
   ОПК МГУ — синхронизация с Google Таблицами
   fire-and-forget: данные уходят в фоне, не блокируют UI
   ================================================================ */

const SHEETS_URL_KEY = 'opk_sheets_webhook_url';

function getSheetsUrl() {
    return localStorage.getItem(SHEETS_URL_KEY) || '';
}

function setSheetsUrl(url) {
    localStorage.setItem(SHEETS_URL_KEY, url.trim());
}

/**
 * Нормализует answersLabeled в массив [{question, answer}].
 * Поддерживает новый формат (array) и старый (object {label: value}).
 */
function normalizeAnswers(answersLabeled) {
    if (Array.isArray(answersLabeled)) return answersLabeled;
    if (answersLabeled && typeof answersLabeled === 'object') {
        return Object.entries(answersLabeled).map(([question, answer]) => ({ question, answer }));
    }
    return [];
}

/**
 * Пытается угадать имя, факультет и курс из answersLabeled.
 * Принимает и массив [{question,answer}], и объект {label:value}.
 */
function extractCommonFields(answersLabeled) {
    const fields = { name: '', faculty: '', year: '' };
    const items = normalizeAnswers(answersLabeled);
    for (const item of items) {
        const q = (item.question || '').toLowerCase();
        const a = item.answer || '';
        if (!fields.name && (q.includes('имя') || q.includes('фио') || q.includes('ф.и.о') || q.includes('name'))) {
            fields.name = a;
        }
        if (!fields.faculty && (q.includes('факульт') || q.includes('школ') || q.includes('институт') || q.includes('кафедр') || q.includes('направлен'))) {
            fields.faculty = a;
        }
        if (!fields.year && (q.includes('курс') || q.includes('год об') || q.includes('учеб'))) {
            fields.year = a;
        }
    }
    return fields;
}

/**
 * Форматирует все ответы в читаемую строку «Вопрос: ответ | …»
 * Принимает и массив [{question,answer}], и объект {label:value}.
 */
function formatAnswersList(answersLabeled) {
    const items = normalizeAnswers(answersLabeled);
    return items
        .filter(item => item.answer !== '' && item.answer != null)
        .map(item => `${item.question}: ${item.answer}`)
        .join(' | ');
}

/**
 * Основная функция — POST в Apps Script, no-cors, fire-and-forget.
 * При отсутствии URL ничего не делает.
 */
function _postToSheets(payload) {
    const url = getSheetsUrl();
    if (!url) return;
    try {
        fetch(url, {
            method: 'POST',
            mode: 'no-cors',
            headers: { 'Content-Type': 'text/plain' },
            body: JSON.stringify(payload)
        }).catch(() => {});
    } catch (_) {}
}

/**
 * Вызывается после успешной регистрации.
 * data = { registrationId, eventId, eventName, status, answersLabeled, contactEmail, contactPhone, createdAt }
 */
function syncRegistration(data) {
    const common = extractCommonFields(data.answersLabeled);
    _postToSheets({
        action: 'register',
        id:           data.registrationId || '',
        registeredAt: data.createdAt || new Date().toISOString(),
        eventName:    data.eventName || '',
        name:         common.name,
        email:        data.contactEmail || '',
        phone:        data.contactPhone || '',
        faculty:      common.faculty,
        year:         common.year,
        status:       data.status || 'confirmed',
        answers:      formatAnswersList(data.answersLabeled)
    });
}

/**
 * Вызывается после отмены записи.
 */
function syncCancellation(registrationId, cancelledAt) {
    _postToSheets({
        action:         'cancel',
        registrationId: registrationId || '',
        cancelledAt:    cancelledAt || new Date().toISOString()
    });
}

/**
 * Вызывается из admin.html — массовая синхронизация.
 * registrations = массив объектов из Firestore
 */
function syncBulk(registrations) {
    _postToSheets({ action: 'bulk_sync', registrations });
}
