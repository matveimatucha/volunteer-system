const {
    REGISTRATION_STATUS,
    buildSheetsRegisterPayload
} = require('./registration-helpers');

function getSheetsUrl() {
    return (process.env.SHEETS_WEBHOOK_URL || '').trim();
}

let cachedSheetsUrl = '';
let cachedSheetsUrlAt = 0;

async function resolveSheetsUrl(db) {
    const fromEnv = getSheetsUrl();
    if (fromEnv) return fromEnv;
    if (!db) return '';

    if (cachedSheetsUrl && Date.now() - cachedSheetsUrlAt < 60000) {
        return cachedSheetsUrl;
    }

    try {
        const snap = await db.collection('settings').doc('integrations').get();
        const url = ((snap.data() || {}).sheetsWebhookUrl || '').trim();
        cachedSheetsUrl = url;
        cachedSheetsUrlAt = Date.now();
        return url;
    } catch (_) {
        return '';
    }
}

async function postToSheets(payload, db) {
    const url = db ? await resolveSheetsUrl(db) : getSheetsUrl();
    if (!url) return false;

    const response = await fetch(url, {
        method: 'POST',
        redirect: 'follow',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify(payload)
    });
    if (!response.ok) {
        console.error('[sheets] sync failed HTTP', response.status);
        return false;
    }
    return true;
}

/** Зеркало логики Firestore-триггера syncToSheets из Cloud Functions. */
async function syncRegistrationWritten(before, after, regId, db) {
    if (!after) return;

    let payload;
    if (after.status === REGISTRATION_STATUS.CANCELLED
        && before && before.status !== REGISTRATION_STATUS.CANCELLED) {
        payload = {
            action: 'cancel',
            registrationId: after.registrationId || regId,
            cancelledAt: after.cancelledAt || new Date().toISOString()
        };
    } else if (!before || before.status !== after.status) {
        payload = buildSheetsRegisterPayload({
            ...after,
            registrationId: after.registrationId || regId
        });
    } else {
        return;
    }

    await postToSheets(payload, db);
}

function scheduleSheetsSync(before, after, regId, db) {
    syncRegistrationWritten(before, after, regId, db).catch((err) => {
        console.error('[sheets] background sync error', err.message);
    });
}

module.exports = {
    getSheetsUrl,
    resolveSheetsUrl,
    postToSheets,
    syncRegistrationWritten,
    scheduleSheetsSync
};
