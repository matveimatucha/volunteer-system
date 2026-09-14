/**
 * Импорт прошлой базы волонтёров из JSON (см. parse-legacy-xlsx.py).
 *
 *   python scripts/parse-legacy-xlsx.py "C:\path\База волонтеров.xlsx" 2026 tmp.json
 *   node scripts/import-legacy-volunteers.js tmp.json
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');
const { initFirebase } = require('../lib/firebase');
const { REGISTRATION_STATUS } = require('../lib/registration-helpers');

const jsonPath = process.argv[2];
if (!jsonPath) {
    console.error('Использование: node scripts/import-legacy-volunteers.js <legacy.json>');
    process.exit(1);
}

const payload = JSON.parse(fs.readFileSync(path.resolve(jsonPath), 'utf8'));
const admin = initFirebase();
const db = admin.firestore();

function answersLabeled(person) {
    const items = [
        { question: 'Фамилия', answer: person.lastName },
        { question: 'Имя', answer: person.firstName },
        { question: 'Отчество', answer: person.middleName },
        { question: 'Факультет', answer: person.faculty },
        { question: 'ВКонтакте', answer: person.vk }
    ];
    return items.filter(i => i.answer);
}

async function commitBatches(ops) {
    const CHUNK = 400;
    for (let i = 0; i < ops.length; i += CHUNK) {
        const batch = db.batch();
        for (const op of ops.slice(i, i + CHUNK)) {
            batch.set(op.ref, op.data);
        }
        await batch.commit();
        console.log(`Записано ${Math.min(i + CHUNK, ops.length)} / ${ops.length}`);
    }
}

(async () => {
    const now = new Date().toISOString();
    const ops = [];
    const eventById = {};

    for (const ev of payload.events) {
        const attendees = payload.people.filter(p => p.attended.includes(ev.id)).length;
        const event = {
            id: ev.id,
            title: ev.title,
            dateRaw: ev.dateRaw || '',
            date: ev.date || ev.dateLabel || '',
            dateEndRaw: ev.dateEndRaw || '',
            dateEnd: ev.dateEnd || '',
            location: 'МГУ',
            description: ev.dateLabel
                ? `Импортировано из прошлой базы волонтёров (${ev.dateLabel}).`
                : 'Импортировано из прошлой базы волонтёров.',
            maxVolunteers: 0,
            currentVolunteers: attendees,
            color: '#1B2480',
            status: 'closed',
            successMessage: '',
            chatLink: '',
            isTemplate: false,
            isArchived: true,
            isLegacyImport: true,
            image: '',
            logo: '',
            archivePhoto: '',
            archiveText: '',
            questions: []
        };
        eventById[ev.id] = event;
        ops.push({ ref: db.collection('events').doc(ev.id), data: event });
    }

    let regs = 0;
    for (const person of payload.people) {
        const labeled = answersLabeled(person);
        for (const eventId of person.attended) {
            const event = eventById[eventId];
            if (!event) continue;
            const registrationId = `legacy-${person.id}-${eventId}`;
            const data = {
                registrationId,
                eventId,
                eventTitle: event.title,
                status: REGISTRATION_STATUS.CONFIRMED,
                contactEmail: '',
                contactPhone: '',
                createdAt: now,
                createdAtMs: Date.now(),
                timestamp: new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' }),
                answers: {},
                answersLabeled: labeled,
                attendance: 'present',
                source: 'legacy-import',
                telegramNotifiedAt: Date.now(),
                cancelToken: `legacy-${person.id}`
            };
            ops.push({ ref: db.collection('registrations').doc(registrationId), data });
            regs++;
        }
    }

    console.log(`Мероприятий: ${payload.events.length}, заявок: ${regs}, человек: ${payload.people.length}`);
    await commitBatches(ops);
    console.log('Готово. Статистика волонтёров подхватит записи сразу.');
    process.exit(0);
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
