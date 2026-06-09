// ================================================================
// ОПК МГУ — Google Apps Script для синхронизации регистраций
//
// КАК УСТАНОВИТЬ:
// 1. Откройте Google Таблицу (создайте новую или используйте существующую)
// 2. Расширения → Apps Script
// 3. Удалите весь код и вставьте весь этот файл
// 4. Сохраните (Ctrl+S)
// 5. Развернуть → Новое развёртывание → Веб-приложение
//    • Выполнять от имени: Меня
//    • Кто имеет доступ: Все
// 6. Нажмите «Развернуть», скопируйте URL
// 7. Вставьте URL в поле «Google Sheets» в админ-панели сайта
// ================================================================

// Лист «Все регистрации» — общий сводный лист
const MASTER_SHEET_NAME = 'Все регистрации';

const HEADERS = [
    'ID регистрации',
    'Дата регистрации',
    'Мероприятие',
    'Имя',
    'Email',
    'Телефон',
    'Факультет / Школа',
    'Курс / Год',
    'Статус',
    'Дата отмены',
    'Все ответы'
];

// ---------- Точка входа для POST-запросов ----------
function doPost(e) {
    try {
        const data = JSON.parse(e.postData.contents);

        // Определяем лист: по имени мероприятия или сводный
        const eventSheetName = data.eventName
            ? sanitizeSheetName_(data.eventName)
            : null;

        if (data.action === 'register') {
            const masterSheet = getOrCreateSheet_(MASTER_SHEET_NAME);
            upsertRegistration_(masterSheet, data);

            if (eventSheetName) {
                const eventSheet = getOrCreateEventSheet_(eventSheetName, data);
                upsertRegistration_(eventSheet, data);
            }
        } else if (data.action === 'cancel') {
            updateStatusAllSheets_(data.registrationId, 'отменена', data.cancelledAt);
        } else if (data.action === 'bulk_sync') {
            bulkSyncAll_(data.registrations);
        }

        return ok_();
    } catch (err) {
        return ok_('error: ' + err.message);
    }
}

// Проверка работоспособности через GET
function doGet() {
    return ContentService
        .createTextOutput(JSON.stringify({ ok: true, sheet: MASTER_SHEET_NAME }))
        .setMimeType(ContentService.MimeType.JSON);
}

// ---------- Работа с листами ----------

// Создаёт или возвращает лист с заданным именем (стандартная шапка)
function getOrCreateSheet_(name) {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    let sheet = ss.getSheetByName(name);

    if (!sheet) {
        sheet = ss.insertSheet(name);
        applyHeader_(sheet, HEADERS);
    }

    return sheet;
}

// Создаёт или возвращает лист мероприятия с динамической шапкой из вопросов формы
function getOrCreateEventSheet_(name, sampleData) {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    let sheet = ss.getSheetByName(name);

    if (!sheet) {
        sheet = ss.insertSheet(name);
        const headers = buildEventHeaders_(sampleData);
        applyHeader_(sheet, headers);
    }

    return sheet;
}

function applyHeader_(sheet, headers) {
    sheet.appendRow(headers);
    const hRange = sheet.getRange(1, 1, 1, headers.length);
    hRange.setBackground('#1B2480');
    hRange.setFontColor('#ffffff');
    hRange.setFontWeight('bold');
    hRange.setFontSize(10);
    sheet.setFrozenRows(1);

    // Авто-ширина первых стандартных колонок
    const stdWidths = [180, 160, 220, 180, 200, 140, 200, 100, 120, 160];
    stdWidths.forEach((w, i) => {
        if (i < headers.length) sheet.setColumnWidth(i + 1, w);
    });
    // Вопросы из формы — пошире
    for (let i = stdWidths.length; i < headers.length; i++) {
        sheet.setColumnWidth(i + 1, 260);
    }
}

// Строит заголовки для листа мероприятия: базовые поля + вопросы формы
function buildEventHeaders_(data) {
    const base = ['ID регистрации', 'Дата регистрации', 'Статус', 'Email', 'Телефон'];
    const questions = extractQuestionLabels_(data.answersLabeled);
    return base.concat(questions);
}

// Достаёт список вопросов из answersLabeled
function extractQuestionLabels_(answersLabeled) {
    if (!answersLabeled) return [];
    if (Array.isArray(answersLabeled)) {
        return answersLabeled.map(item => item.question || '').filter(Boolean);
    }
    if (typeof answersLabeled === 'object') {
        return Object.keys(answersLabeled);
    }
    return [];
}

function upsertRegistration_(sheet, data) {
    const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    const isEventSheet = !headers.includes('Мероприятие');

    const existing = findRow_(sheet, data.id || data.registrationId);
    const row = isEventSheet
        ? buildEventRow_(headers, data)
        : buildRow_(data);

    if (existing > 0) {
        sheet.getRange(existing, 1, 1, row.length).setValues([row]);
    } else {
        // Если лист мероприятия и появились новые вопросы — расширить шапку
        if (isEventSheet) expandEventSheetHeaders_(sheet, data);
        sheet.appendRow(buildEventRow_(sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0], data));
        colorStatus_(sheet, sheet.getLastRow(), data.status);
    }
}

// Добавляет недостающие колонки вопросов в шапку листа мероприятия
function expandEventSheetHeaders_(sheet, data) {
    const existing = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    const newQuestions = extractQuestionLabels_(data.answersLabeled);
    newQuestions.forEach(q => {
        if (!existing.includes(q)) {
            const col = sheet.getLastColumn() + 1;
            sheet.getRange(1, col).setValue(q)
                .setBackground('#1B2480').setFontColor('#ffffff').setFontWeight('bold');
            sheet.setColumnWidth(col, 260);
            existing.push(q);
        }
    });
}

function buildEventRow_(headers, data) {
    const answers = normalizeAnswers_(data.answersLabeled);
    return headers.map(h => {
        if (h === 'ID регистрации')   return data.id || data.registrationId || '';
        if (h === 'Дата регистрации') return data.registeredAt ? fmtDate_(data.registeredAt) : '';
        if (h === 'Статус')           return statusLabel_(data.status);
        if (h === 'Email')            return data.email || data.contactEmail || '';
        if (h === 'Телефон')          return data.phone || data.contactPhone || '';
        // вопросы формы
        const a = answers.find(item => item.question === h);
        return a ? a.answer : '';
    });
}

function updateStatusAllSheets_(id, statusText, cancelledAt) {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    ss.getSheets().forEach(sheet => {
        const row = findRow_(sheet, id);
        if (row <= 0) return;

        const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
        const statusCol = headers.indexOf('Статус') + 1;
        const cancelCol = headers.indexOf('Дата отмены') + 1;

        if (statusCol > 0) sheet.getRange(row, statusCol).setValue(statusText || 'отменена');
        if (cancelCol > 0 && cancelledAt) sheet.getRange(row, cancelCol).setValue(fmtDate_(cancelledAt));

        colorStatus_(sheet, row, 'cancelled');
    });
}

// Полная синхронизация: общий лист + отдельный лист на каждое мероприятие
function bulkSyncAll_(registrations) {
    if (!registrations || !registrations.length) return;

    // 1. Пишем всё в общий сводный лист
    const masterSheet = getOrCreateSheet_(MASTER_SHEET_NAME);
    const lastRow = masterSheet.getLastRow();
    if (lastRow > 1) {
        masterSheet.getRange(2, 1, lastRow - 1, masterSheet.getLastColumn()).clearContent();
    }
    const masterRows = registrations.map(r => buildRow_(r));
    masterSheet.getRange(2, 1, masterRows.length, HEADERS.length).setValues(masterRows);
    registrations.forEach((r, i) => colorStatus_(masterSheet, i + 2, r.status));

    // 2. Группируем по мероприятию и пишем на отдельные листы
    const byEvent = {};
    registrations.forEach(r => {
        const name = sanitizeSheetName_(r.eventName || r.eventTitle || '');
        if (!name) return;
        if (!byEvent[name]) byEvent[name] = [];
        byEvent[name].push(r);
    });

    Object.entries(byEvent).forEach(([sheetName, regs]) => {
        // Собираем ВСЕ уникальные вопросы по всем записям мероприятия
        const allQuestions = collectAllQuestions_(regs);
        const fullHeaders = ['ID регистрации', 'Дата регистрации', 'Статус', 'Email', 'Телефон']
            .concat(allQuestions);

        // Пересоздаём лист с полной шапкой (удаляем старый если есть)
        const ss = SpreadsheetApp.getActiveSpreadsheet();
        const existing = ss.getSheetByName(sheetName);
        if (existing) ss.deleteSheet(existing);
        const eventSheet = ss.insertSheet(sheetName);
        applyHeader_(eventSheet, fullHeaders);

        // Пишем все строки
        const rows = regs.map(r => buildEventRow_(fullHeaders, r));
        if (rows.length > 0) {
            eventSheet.getRange(2, 1, rows.length, fullHeaders.length).setValues(rows);
            regs.forEach((r, i) => colorStatus_(eventSheet, i + 2, r.status));
        }
    });
}

// Собирает все уникальные вопросы из массива регистраций (сохраняет порядок)
function collectAllQuestions_(registrations) {
    const seen = new Set();
    const questions = [];
    registrations.forEach(r => {
        extractQuestionLabels_(r.answersLabeled).forEach(q => {
            if (q && !seen.has(q)) {
                seen.add(q);
                questions.push(q);
            }
        });
    });
    return questions;
}

// ---------- Вспомогательные ----------

function buildRow_(d) {
    return [
        d.id || d.registrationId || '',
        d.registeredAt ? fmtDate_(d.registeredAt) : '',
        d.eventName || d.eventTitle || '',
        d.name || '',
        d.email || d.contactEmail || '',
        d.phone || d.contactPhone || '',
        d.faculty || '',
        d.year || d.course || '',
        statusLabel_(d.status),
        d.cancelledAt ? fmtDate_(d.cancelledAt) : '',
        d.answers || ''
    ];
}

function normalizeAnswers_(answersLabeled) {
    if (Array.isArray(answersLabeled)) return answersLabeled;
    if (answersLabeled && typeof answersLabeled === 'object') {
        return Object.entries(answersLabeled).map(([question, answer]) => ({ question, answer }));
    }
    return [];
}

function findRow_(sheet, id) {
    if (!id) return -1;
    const values = sheet.getDataRange().getValues();
    for (let i = 1; i < values.length; i++) {
        if (String(values[i][0]) === String(id)) return i + 1;
    }
    return -1;
}

function colorStatus_(sheet, row, status) {
    const colors = {
        confirmed: '#d4edda',
        pending:   '#fff3cd',
        cancelled: '#f8d7da',
        waitlist:  '#d1ecf1'
    };
    // Красим весь ряд слегка, и ячейку статуса ярче
    const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    const statusCol = headers.indexOf('Статус') + 1;
    if (statusCol > 0) {
        sheet.getRange(row, statusCol).setBackground(colors[status] || '#ffffff');
    }
}

function statusLabel_(status) {
    const map = {
        confirmed: 'подтверждена',
        pending:   'ожидает',
        cancelled: 'отменена',
        waitlist:  'лист ожидания'
    };
    return map[status] || status || 'ожидает';
}

function fmtDate_(iso) {
    try {
        return new Date(iso).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' });
    } catch (_) {
        return iso || '';
    }
}

// Убирает символы, недопустимые в именах листов Google Sheets
function sanitizeSheetName_(name) {
    return String(name)
        .replace(/[\\\/\?\*\[\]\:]/g, ' ')
        .trim()
        .slice(0, 100);
}

function ok_(msg) {
    return ContentService
        .createTextOutput(JSON.stringify({ success: true, msg: msg || '' }))
        .setMimeType(ContentService.MimeType.JSON);
}
