/**
 * Создаёт аккаунты Firebase Auth (если их ещё нет) и выдаёт права администратора.
 *
 * Использование (из каталога server/):
 *   node scripts/create-admins.js scripts/admin-accounts.local.json
 *   node scripts/create-admins.js scripts/admin-accounts.local.json --reset-links
 *
 * JSON: [{ "email": "...", "firstName": "...", "lastName": "...", "password": "...", "super": false }]
 * Если в JSON есть password — ставит его (новым и существующим). Ссылки на сброс
 * печатает только с флагом --reset-links; письма скрипт сам не отправляет.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { initFirebase } = require('../lib/firebase');

const args = process.argv.slice(2);
const fileArg = args.find((a) => !a.startsWith('--'));
const forceResetLinks = args.includes('--reset-links');

if (!fileArg) {
    console.error('Использование: node scripts/create-admins.js <people.json> [--reset-links]');
    process.exit(1);
}

function loadPeople(filePath) {
    const raw = fs.readFileSync(filePath, 'utf8');
    const data = JSON.parse(raw);
    if (!Array.isArray(data) || !data.length) {
        throw new Error('JSON должен быть непустым массивом');
    }
    return data.map((row, index) => {
        const email = String(row.email || '').trim().toLowerCase();
        if (!email || !email.includes('@')) {
            throw new Error(`Строка ${index + 1}: некорректный email`);
        }
        const password = String(row.password || '').trim();
        if (password && password.length < 6) {
            throw new Error(`Строка ${index + 1}: пароль короче 6 символов`);
        }
        return {
            email,
            firstName: String(row.firstName || '').trim(),
            lastName: String(row.lastName || '').trim(),
            password,
            super: row.super === true
        };
    });
}

function randomPassword() {
    return `${crypto.randomBytes(24).toString('base64url')}Aa1!`;
}

async function ensureAdmin(auth, person) {
    const displayName = `${person.firstName} ${person.lastName}`.trim();
    const superMode = person.super === true;
    const claims = superMode
        ? { admin: true, superadmin: true }
        : { admin: true };

    let user;
    let created = false;
    try {
        user = await auth.getUserByEmail(person.email);
    } catch (err) {
        if (err.code !== 'auth/user-not-found') throw err;
        user = await auth.createUser({
            email: person.email,
            password: person.password || randomPassword(),
            displayName: displayName || undefined,
            disabled: false
        });
        created = true;
    }

    const patch = {};
    if (displayName && user.displayName !== displayName) patch.displayName = displayName;
    if (!created && person.password) patch.password = person.password;
    if (Object.keys(patch).length) {
        user = await auth.updateUser(user.uid, patch);
    }

    const nextClaims = { ...(user.customClaims || {}), ...claims };
    await auth.setCustomUserClaims(user.uid, nextClaims);

    let resetLink = '';
    let resetError = '';
    if (forceResetLinks) {
        try {
            resetLink = await auth.generatePasswordResetLink(person.email);
        } catch (err) {
            resetError = err.message;
        }
    }

    return {
        email: person.email,
        name: displayName || '—',
        uid: user.uid,
        created,
        role: superMode ? 'superadmin' : 'admin',
        resetLink,
        resetError
    };
}

(async () => {
    const filePath = path.resolve(process.cwd(), fileArg);
    const people = loadPeople(filePath);
    const admin = initFirebase();
    const results = [];

    for (const person of people) {
        try {
            const row = await ensureAdmin(admin.auth(), person);
            results.push({ ok: true, ...row });
            const mark = row.created ? 'создан' : 'уже был';
            console.error(`✓ ${row.email} — ${mark}, ${row.role}`);
        } catch (err) {
            results.push({
                ok: false,
                email: person.email,
                name: `${person.firstName} ${person.lastName}`.trim(),
                error: err.message
            });
            console.error(`✗ ${person.email} — ${err.message}`);
        }
    }

    const outPath = path.join(__dirname, 'admin-invite-links.local.txt');
    const lines = [
        `Админы созданы: ${new Date().toISOString()}`,
        'Ссылки на пароль живут около часа. Если протухли — «Не помню пароль» на admin.html.',
        '',
        ...results.map((row) => {
            if (!row.ok) return `${row.name}\t${row.email}\tОШИБКА\t${row.error}`;
            const link = row.resetLink || (forceResetLinks ? (row.resetError || 'ссылка не создана') : 'без ссылки');
            return `${row.name}\t${row.email}\t${row.role}\t${row.created ? 'создан' : 'существовал'}\t${link}`;
        }),
        ''
    ];
    fs.writeFileSync(outPath, lines.join('\n'), 'utf8');

    console.log(JSON.stringify({
        total: results.length,
        created: results.filter((r) => r.ok && r.created).length,
        existing: results.filter((r) => r.ok && !r.created).length,
        failed: results.filter((r) => !r.ok).length,
        report: outPath,
        people: results
    }, null, 2));
    process.exit(results.some((r) => !r.ok) ? 1 : 0);
})().catch((err) => {
    console.error('Ошибка:', err.message);
    process.exit(1);
});
