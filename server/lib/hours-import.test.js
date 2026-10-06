const test = require('node:test');
const assert = require('node:assert/strict');
const { buildHoursPreview, parseHoursCell, normalizeCourse, sanitizeImportRows } = require('./hours-import');
const { readHoursSheet, buildHoursTemplate, buildSheetFile } = require('./hours-xlsx');

function person(id, last, first, middle, faculty, year, extra = {}) {
    const answersLabeled = [
        { question: 'Фамилия', answer: last },
        { question: 'Имя', answer: first }
    ];
    if (middle) answersLabeled.push({ question: 'Отчество', answer: middle });
    if (faculty) answersLabeled.push({ question: 'Факультет', answer: faculty });
    if (year) answersLabeled.push({ question: 'Курс', answer: year });
    return { registrationId: id, status: 'confirmed', answersLabeled, ...extra };
}

function row(partial) {
    return {
        row: partial.row || 2,
        name: partial.name || '',
        faculty: partial.faculty || '',
        year: partial.year || '',
        hours: partial.hours == null ? null : partial.hours,
        hoursError: partial.hoursError || '',
        comment: partial.comment || ''
    };
}

test('course and hours parsing', () => {
    assert.equal(normalizeCourse('1 курс'), '1');
    assert.equal(normalizeCourse('Первый'), '1');
    assert.equal(parseHoursCell('1,5').hours, 1.5);
    assert.equal(parseHoursCell(0).hours, null);
    assert.equal(parseHoursCell('').hours, null);
    assert.ok(parseHoursCell('1.2').error);
    assert.ok(parseHoursCell(80).error);
});

test('matches hours, absence and comments', () => {
    const regs = [
        person('a', 'Иванов', 'Иван', 'Иванович', 'Экономический факультет', '2 курс'),
        person('b', 'Петрова', 'Анна', 'Сергеевна', 'Юридический факультет', '1', { coordinatorNote: 'старое' }),
        person('c', 'Сидоров', 'Пётр', '', 'Исторический факультет', '3')
    ];
    const preview = buildHoursPreview(regs, [
        row({ row: 2, name: 'иванов иван иванович', faculty: 'экономический факультет', year: 'второй', hours: 4.5, comment: 'хорошо держал стойку' }),
        row({ row: 3, name: 'Петрова Анна Сергеевна', faculty: 'Юридический факультет', year: '1', hours: null, comment: 'заболела' })
    ], {});

    assert.equal(preview.ready, true);
    assert.equal(preview.summary.present, 1);
    assert.equal(preview.summary.absent, 2);
    assert.deepEqual(preview.missing.map(item => item.registrationId), ['c']);

    const ivanov = preview.updates.find(item => item.registrationId === 'a');
    assert.equal(ivanov.attendance, 'present');
    assert.equal(ivanov.workedHours, 4.5);
    assert.equal(ivanov.coordinatorNote, 'хорошо держал стойку');

    const petrova = preview.updates.find(item => item.registrationId === 'b');
    assert.equal(petrova.attendance, 'absent');
    assert.equal(petrova.workedHours, null);
    assert.equal(petrova.updateComment, true);
    assert.equal(petrova.coordinatorNote, 'заболела');

    const sidorov = preview.updates.find(item => item.registrationId === 'c');
    assert.equal(sidorov.attendance, 'absent');
    assert.equal(sidorov.updateComment, false);
});

test('name order, yo and partial patronymic', () => {
    const regs = [
        person('a', 'Смирнов', 'Пётр', 'Олегович', 'Филологический факультет', '4')
    ];
    const preview = buildHoursPreview(regs, [
        row({ name: 'Петр Смирнов', faculty: 'филологический', year: '4 курс', hours: 2, comment: '' })
    ], {});
    assert.equal(preview.rows[0].status, 'present');
    assert.equal(preview.rows[0].registrationId, 'a');
    assert.equal(preview.updates[0].coordinatorNote, '');
    assert.equal(preview.updates[0].updateComment, true);
});

test('ambiguous choice and conflicts block saving', () => {
    const regs = [
        person('a', 'Иванов', 'Иван', 'Иванович', 'Физический факультет', '1'),
        person('b', 'Иванов', 'Иван', 'Петрович', 'Физический факультет', '1')
    ];
    const rows = [
        row({ row: 2, name: 'Иванов Иван', faculty: 'Физический факультет', year: '1', hours: 3, comment: '' })
    ];
    const ambiguous = buildHoursPreview(regs, rows, {});
    assert.equal(ambiguous.rows[0].status, 'ambiguous');
    assert.equal(ambiguous.ready, false);

    const chosen = buildHoursPreview(regs, rows, { 2: 'b' });
    assert.equal(chosen.rows[0].registrationId, 'b');
    assert.equal(chosen.ready, true);
    assert.equal(chosen.updates.find(item => item.registrationId === 'a').attendance, 'absent');

    const conflict = buildHoursPreview(regs, [
        row({ row: 2, name: 'Иванов Иван Иванович', faculty: 'Физический факультет', year: '1', hours: 3 }),
        row({ row: 3, name: 'Иванов Иван Иванович', faculty: 'Физический факультет', year: '1', hours: 4 })
    ], {});
    assert.equal(conflict.rows[0].status, 'conflict');
    assert.equal(conflict.ready, false);
});

test('unknown row is skipped and invalid hours block saving', () => {
    const regs = [person('a', 'Орлова', 'Мария', '', 'Химический факультет', '2')];
    const unknown = buildHoursPreview(regs, [
        row({ name: 'Чужой Человек', faculty: 'Химический факультет', year: '2', hours: 5 })
    ], {});
    assert.equal(unknown.rows[0].status, 'unknown');
    assert.equal(unknown.summary.absent, 1);
    assert.equal(unknown.ready, true);

    const invalid = buildHoursPreview(regs, [
        row({ name: 'Орлова Мария', faculty: 'Химический факультет', year: '2', hours: null, hoursError: 'Часы должны быть от 0 до 72' })
    ], {});
    assert.equal(invalid.rows[0].status, 'invalid');
    assert.equal(invalid.ready, false);
    assert.equal(invalid.missing.length, 0);

    const kept = sanitizeImportRows([{
        row: 2,
        name: 'Орлова Мария',
        faculty: 'Химический факультет',
        year: '2',
        hours: null,
        hoursRaw: 'много',
        comment: ''
    }]);
    const again = buildHoursPreview(regs, kept.rows, {});
    assert.equal(again.rows[0].status, 'invalid');
    assert.equal(again.ready, false);
});

test('participants workbook', async () => {
    const ExcelJS = require('exceljs');
    const buffer = await buildSheetFile(['Имя', 'Часы'], [['Иван', 3.5]]);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);
    const sheet = workbook.worksheets[0];
    assert.equal(sheet.getRow(1).getCell(1).value, 'Имя');
    assert.equal(sheet.getRow(2).getCell(2).value, 3.5);
});

test('excel template roundtrip', async () => {
    const regs = [
        person('a', 'Иванов', 'Иван', 'Иванович', 'Экономический факультет', '2', { workedHours: 3, coordinatorNote: 'уже был' }),
        person('b', 'Петрова', 'Анна', '', 'Юридический факультет', '1')
    ];
    const buffer = await buildHoursTemplate(regs);
    const parsed = await readHoursSheet(buffer);
    assert.equal(parsed.rows.length, 2);
    const ivanov = parsed.rows.find(item => item.name.includes('Иванов'));
    assert.equal(ivanov.hours, 3);
    assert.equal(ivanov.comment, 'уже был');
    const preview = buildHoursPreview(regs, parsed.rows, {});
    assert.equal(preview.ready, true);
    assert.equal(preview.summary.present, 1);
    assert.equal(preview.summary.absent, 1);
    assert.equal(preview.missing.length, 0);
});
