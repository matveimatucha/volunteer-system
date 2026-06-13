/**
 * Выдаёт пользователю Firebase Auth права администратора (custom claim admin: true).
 *
 * Использование (из каталога functions/):
 *   1. Аутентифицируйтесь: npx firebase login  (или задайте GOOGLE_APPLICATION_CREDENTIALS)
 *   2. node scripts/set-admin.js admin@example.com
 *
 * Пользователь должен быть заранее создан в консоли Firebase
 * (Authentication → Users → Add user).
 */

const admin = require('firebase-admin');

const email = process.argv[2];
if (!email) {
    console.error('Использование: node scripts/set-admin.js <email>');
    process.exit(1);
}

admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT || 'volunteer-system-6ce7f' });

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
