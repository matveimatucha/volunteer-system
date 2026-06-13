const {
    REGISTRATION_STATUS,
    buildSheetsRegisterPayload
} = require('./registration-helpers');

function getSheetsUrl() {
    return (process.env.SHEETS_WEBHOOK_URL || '').trim();
}

async function postToSheets(payload) {
    const url = getSheetsUrl();
    if (!url) return;

    const response = await fetch(url, {
        method: 'POST',
        redirect: 'follow',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify(payload)
    });
    if (!response.ok) {
        console.error('[sheets] sync failed HTTP', response.status);
    }
}

/** Зеркало логики Firestore-триггера syncToSheets из Cloud Functions. */
async function syncRegistrationWritten(before, after, regId) {
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

    await postToSheets(payload);
}

function scheduleSheetsSync(before, after, regId) {
    syncRegistrationWritten(before, after, regId).catch((err) => {
        console.error('[sheets] background sync error', err.message);
    });
}

module.exports = {
    getSheetsUrl,
    postToSheets,
    syncRegistrationWritten,
    scheduleSheetsSync
};
