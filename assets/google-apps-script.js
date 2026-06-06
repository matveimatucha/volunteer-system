// ================================================================
// ОПК МГУ — Google Apps Script для синхронизации регистраций
//
// КАК УСТАНОВИТЬ:
// 1. Откройте Google Таблицу (создайте новую или используйте существующую)
// 2. Extensions → Apps Script
// 3. Удалите весь код и вставьте весь этот файл
// 4. Сохраните (Ctrl+S)
// 5. Deploy → New deployment → Web app
//    • Execute as: Me
//    • Who has access: Anyone
// 6. Нажмите Deploy, скопируйте URL
// 7. Вставьте URL в поле «Google Sheets» в админ-панели сайта
// ================================================================

const SHEET_NAME = 'Регистрации';

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
        const sheet = getOrCreateSheet_();

        if (data.action === 'register') {
            upsertRegistration_(sheet, data);
        } else if (data.action === 'cancel') {
            updateStatus_(sheet, data.registrationId, 'отменена', data.cancelledAt);
        } else if (data.action === 'bulk_sync') {
            bulkSync_(sheet, data.registrations);
        }

        return ok_();
    } catch (err) {
        return ok_('error: ' + err.message);
    }
}

// Проверка работоспособности через GET
function doGet() {
    return ContentService
        .createTextOutput(JSON.stringify({ ok: true, sheet: SHEET_NAME }))
        .setMimeType(ContentService.MimeType.JSON);
}

// ---------- Работа с листом ----------
function getOrCreateSheet_() {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    let sheet = ss.getSheetByName(SHEET_NAME);

    if (!sheet) {
        sheet = ss.insertSheet(SHEET_NAME);
        sheet.appendRow(HEADERS);

        // Оформление шапки
        const hRange = sheet.getRange(1, 1, 1, HEADERS.length);
        hRange.setBackground('#1B2480');
        hRange.setFontColor('#ffffff');
        hRange.setFontWeight('bold');
        hRange.setFontSize(10);
        sheet.setFrozenRows(1);

        // Ширина колонок
        const widths = [180, 160, 220, 180, 200, 140, 200, 100, 120, 160, 400];
        widths.forEach((w, i) => sheet.setColumnWidth(i + 1, w));
    }

    return sheet;
}

function upsertRegistration_(sheet, data) {
    const existing = findRow_(sheet, data.id);
    const row = buildRow_(data);

    if (existing > 0) {
        sheet.getRange(existing, 1, 1, HEADERS.length).setValues([row]);
    } else {
        sheet.appendRow(row);
        colorStatus_(sheet, sheet.getLastRow(), data.status);
    }
}

function updateStatus_(sheet, id, statusText, cancelledAt) {
    const row = findRow_(sheet, id);
    if (row <= 0) return;

    sheet.getRange(row, 9).setValue(statusText || 'отменена');

    if (cancelledAt) {
        sheet.getRange(row, 10).setValue(fmtDate_(cancelledAt));
    }

    colorStatus_(sheet, row, 'cancelled');
}

function bulkSync_(sheet, registrations) {
    if (!registrations || !registrations.length) return;

    // Удаляем все строки кроме шапки
    const lastRow = sheet.getLastRow();
    if (lastRow > 1) {
        sheet.getRange(2, 1, lastRow - 1, HEADERS.length).clearContent();
    }

    const rows = registrations.map(r => buildRow_(r));
    sheet.getRange(2, 1, rows.length, HEADERS.length).setValues(rows);

    // Раскрашиваем статусы
    registrations.forEach((r, i) => colorStatus_(sheet, i + 2, r.status));
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
        confirmed:  '#d4edda',
        pending:    '#fff3cd',
        cancelled:  '#f8d7da',
        waitlist:   '#d1ecf1'
    };
    sheet.getRange(row, 9).setBackground(colors[status] || '#ffffff');
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

function ok_(msg) {
    return ContentService
        .createTextOutput(JSON.stringify({ success: true, msg: msg || '' }))
        .setMimeType(ContentService.MimeType.JSON);
}
