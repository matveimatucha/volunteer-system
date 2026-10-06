const test = require('node:test');
const assert = require('node:assert/strict');
const { samePerson, findBlacklistHits, mergeReason, personIdentity } = require('./blacklist');

function reg(partial) {
    const answersLabeled = [
        { question: 'Фамилия', answer: partial.last },
        { question: 'Имя', answer: partial.first }
    ];
    if (partial.middle) answersLabeled.push({ question: 'Отчество', answer: partial.middle });
    if (partial.faculty) answersLabeled.push({ question: 'Факультет', answer: partial.faculty });
    if (partial.year) answersLabeled.push({ question: 'Курс', answer: partial.year });
    return {
        answersLabeled,
        contactEmail: partial.email || '',
        contactPhone: partial.phone || '',
        eventTitle: partial.eventTitle || ''
    };
}

test('blacklist matches fio faculty course, email and phone', () => {
    const listed = {
        id: '1',
        ...personIdentity(reg({
            last: 'Иванов', first: 'Иван', middle: 'Иванович',
            faculty: 'Экономический факультет', year: '2',
            email: 'ivan@msu.ru', phone: '+7 999 111-22-33'
        })),
        reason: 'не пришёл без предупреждения',
        eventTitles: ['Субботник']
    };
    listed.email = 'ivan@msu.ru';
    listed.phone = personIdentity(reg({ last: 'Иванов', first: 'Иван', phone: '+7 999 111-22-33' })).phone;

    const byName = findBlacklistHits([listed], reg({
        last: 'иванов', first: 'Иван', middle: 'Иванович',
        faculty: 'экономический', year: 'второй'
    }));
    assert.equal(byName.length, 1);
    assert.equal(byName[0].reason, 'не пришёл без предупреждения');

    const byEmail = findBlacklistHits([listed], reg({
        last: 'Петров', first: 'Пётр', faculty: 'Юридический факультет', year: '1',
        email: 'Ivan@msu.ru'
    }));
    assert.equal(byEmail.length, 1);

    const byPhone = findBlacklistHits([listed], reg({
        last: 'Сидоров', first: 'Сидор', faculty: 'Исторический факультет', year: '4',
        phone: '89991112233'
    }));
    assert.equal(byPhone.length, 1);

    const otherFaculty = findBlacklistHits([listed], reg({
        last: 'Иванов', first: 'Иван', middle: 'Иванович',
        faculty: 'Физический факультет', year: '2'
    }));
    assert.equal(otherFaculty.length, 0);
});

test('blacklist reason grows without repeating the same line', () => {
    assert.equal(mergeReason('опоздал', 'не вышел на связь'), 'опоздал\nне вышел на связь');
    assert.equal(mergeReason('опоздал', 'опоздал'), 'опоздал');
});

test('empty course does not match by name alone', () => {
    const left = personIdentity(reg({ last: 'Орлова', first: 'Мария', faculty: 'Химический факультет' }));
    const right = personIdentity(reg({ last: 'Орлова', first: 'Мария', faculty: 'Химический факультет' }));
    assert.equal(samePerson(left, right), false);
});
