const ExcelJS = require('exceljs');
const { parseHoursCell, registrationProfile } = require('./hours-import');
const { isConfirmedRegistration } = require('./registration-helpers');

const COLUMNS = [
    { header: 'ФИО', key: 'fio', width: 36 },
    { header: 'Факультет', key: 'faculty', width: 32 },
    { header: 'Курс', key: 'course', width: 14 },
    { header: 'Часы', key: 'hours', width: 12 },
    { header: 'Комментарий', key: 'comment', width: 42 }
];

function fileError(message) {
    const err = new Error(message);
    err.code = 'BAD_FILE';
    return err;
}

function cellText(value) {
    if (value == null) return '';
    if (value instanceof Date) return '';
    if (typeof value === 'object') {
        if (Array.isArray(value.richText)) return value.richText.map(part => part.text || '').join('').trim();
        if (value.text != null) return String(value.text).trim();
        if (value.result != null) return cellText(value.result);
        return '';
    }
    return String(value).trim();
}

function headerKey(value) {
    const text = cellText(value)
        .toLowerCase()
        .replace(/ё/g, 'е')
        .replace(/\s+/g, ' ')
        .trim();
    if (!text) return '';
    if (text === 'фио' || text.includes('ф.и.о') || text.includes('фамилия имя') || text.startsWith('фио ')) return 'fio';
    if (text.includes('факульт')) return 'faculty';
    if (text === 'курс' || text.startsWith('курс ') || text.startsWith('курс/')) return 'course';
    if (text === 'часы' || text.startsWith('часы') || text.startsWith('часов')) return 'hours';
    if (text.includes('коммент') || text === 'заметка') return 'comment';
    return '';
}

function findHeader(sheet) {
    const last = Math.min(sheet.rowCount || 0, 5);
    for (let rowNumber = 1; rowNumber <= last; rowNumber++) {
        const row = sheet.getRow(rowNumber);
        const map = {};
        const cellCount = Math.max(row.cellCount || 0, COLUMNS.length);
        for (let col = 1; col <= cellCount; col++) {
            const key = headerKey(row.getCell(col).value);
            if (key && map[key] == null) map[key] = col;
        }
        if (map.fio && map.faculty && map.course && map.hours) return { rowNumber, map };
    }
    return null;
}

async function readHoursSheet(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length < 4 || buffer[0] !== 0x50 || buffer[1] !== 0x4b) {
        throw fileError('Нужен файл Excel в формате .xlsx');
    }
    const workbook = new ExcelJS.Workbook();
    try {
        await workbook.xlsx.load(buffer);
    } catch {
        throw fileError('Не удалось прочитать файл. Сохраните таблицу как .xlsx');
    }
    const sheet = workbook.worksheets[0];
    if (!sheet) throw fileError('В файле нет листов');
    const header = findHeader(sheet);
    if (!header) {
        throw fileError('В первой строке нужны колонки: ФИО, Факультет, Курс, Часы, Комментарий');
    }

    const rows = [];
    const lastRow = sheet.rowCount || 0;
    for (let rowNumber = header.rowNumber + 1; rowNumber <= lastRow; rowNumber++) {
        const row = sheet.getRow(rowNumber);
        const read = (key) => {
            const col = header.map[key];
            return col ? row.getCell(col).value : null;
        };
        const name = cellText(read('fio'));
        const faculty = cellText(read('faculty'));
        const year = cellText(read('course'));
        const comment = cellText(read('comment')).slice(0, 1000);
        const hoursValue = read('hours');
        const hoursText = cellText(hoursValue);
        const parsed = parseHoursCell(typeof hoursValue === 'number' ? hoursValue : hoursText);
        if (!name && !faculty && !year && !comment && parsed.hours == null && !parsed.error) continue;
        rows.push({
            row: rowNumber,
            name,
            faculty,
            year,
            hours: parsed.hours,
            hoursRaw: typeof hoursValue === 'number' ? hoursValue : hoursText,
            hoursError: parsed.error,
            comment
        });
        if (rows.length > 5000) throw fileError('В файле больше 5000 строк');
    }
    return { rows };
}

async function buildHoursTemplate(registrations) {
    const confirmed = (registrations || [])
        .filter(isConfirmedRegistration)
        .map(registrationProfile)
        .sort((a, b) => a.name.localeCompare(b.name, 'ru') || a.faculty.localeCompare(b.faculty, 'ru'));
    const byId = new Map((registrations || []).map(reg => [reg.registrationId, reg]));

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Часы');
    sheet.columns = COLUMNS;
    const header = sheet.getRow(1);
    header.font = { bold: true };
    header.alignment = { vertical: 'middle' };
    sheet.views = [{ state: 'frozen', ySplit: 1 }];
    sheet.autoFilter = { from: 'A1', to: 'E1' };

    confirmed.forEach(profile => {
        const source = byId.get(profile.registrationId) || {};
        const hours = source.workedHours == null ? null : Number(source.workedHours);
        sheet.addRow({
            fio: profile.name,
            faculty: profile.faculty,
            course: profile.year,
            hours: Number.isFinite(hours) && hours > 0 ? hours : null,
            comment: String(source.coordinatorNote || '')
        });
    });

    const buffer = await workbook.xlsx.writeBuffer();
    return Buffer.from(buffer);
}

async function buildSheetFile(headers, rows) {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Участники');
    const headerRow = sheet.addRow(headers.map(header => String(header ?? '')));
    headerRow.font = { bold: true };
    sheet.views = [{ state: 'frozen', ySplit: 1 }];
    sheet.autoFilter = {
        from: { row: 1, column: 1 },
        to: { row: 1, column: Math.max(headers.length, 1) }
    };
    for (const row of rows) {
        sheet.addRow(row.map(value => {
            if (typeof value === 'number' && Number.isFinite(value)) return value;
            if (value == null) return '';
            return String(value).slice(0, 8000);
        }));
    }
    sheet.columns.forEach((column, index) => {
        const header = String(headers[index] || '');
        column.width = Math.min(42, Math.max(14, header.length + 4));
    });
    return Buffer.from(await workbook.xlsx.writeBuffer());
}

module.exports = { readHoursSheet, buildHoursTemplate, buildSheetFile };
