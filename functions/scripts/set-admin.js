/**
 * Выдаёт пользователю Firebase Auth права администратора.
 *
 * Использование (из каталога functions/):
 *   node scripts/set-admin.js admin@example.com          — обычная админка
 *   node scripts/set-admin.js admin@example.com --super  — супер-админка
 */

const admin = require('firebase-admin');

const args = process.argv.slice(2);
const email = args.find((a) => !a.startsWith('--'));
const AUTO_SUPER_EMAILS = new Set([
    'matvei.sukmanov@chemistry.msu.ru'
]);
const superMode = args.includes('--super')
    || (email && AUTO_SUPER_EMAILS.has(email.toLowerCase()));

if (!email) {
    console.error('Использование: node scripts/set-admin.js <email> [--super]');
    process.exit(1);
}

admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT || 'volunteer-system-6ce7f' });

(async () => {
    try {
        const user = await admin.auth().getUserByEmail(email);
        const claims = superMode
            ? { admin: true, superadmin: true }
            : { admin: true };
        await admin.auth().setCustomUserClaims(user.uid, claims);
        const role = superMode ? 'супер-администратор' : 'администратор';
        console.log(`Готово: ${email} (uid ${user.uid}) теперь ${role}.`);
        console.log('Пользователю нужно перелогиниться, чтобы получить новый токен.');
        process.exit(0);
    } catch (err) {
        console.error('Ошибка:', err.message);
        process.exit(1);
    }
})();
