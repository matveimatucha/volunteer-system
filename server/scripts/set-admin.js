/**
 * Выдаёт пользователю Firebase Auth права администратора (custom claim admin: true).
 *
 * Использование (из каталога server/):
 *   1. Заполните .env (GOOGLE_APPLICATION_CREDENTIALS)
 *   2. node scripts/set-admin.js admin@example.com
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { initFirebase } = require('../lib/firebase');

const email = process.argv[2];
if (!email) {
    console.error('Использование: node scripts/set-admin.js <email>');
    process.exit(1);
}

const admin = initFirebase();

(async () => {
    try {
        const user = await admin.auth().getUserByEmail(email);
        await admin.auth().setCustomUserClaims(user.uid, { admin: true });
        console.log(`Готово: ${email} (uid ${user.uid}) теперь администратор.`);
        console.log('Пользователю нужно перелогиниться, чтобы получить новый токен.');
        process.exit(0);
    } catch (err) {
        console.error('Ошибка:', err.message);
        process.exit(1);
    }
})();
