const path = require('path');
const admin = require('firebase-admin');

function initFirebase() {
    if (admin.apps.length) return admin;

    const projectId = process.env.FIREBASE_PROJECT_ID || 'volunteer-system-6ce7f';
    const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;

    if (credPath) {
        const resolved = path.isAbsolute(credPath)
            ? credPath
            : path.resolve(process.cwd(), credPath);
        admin.initializeApp({
            credential: admin.credential.cert(require(resolved)),
            projectId
        });
    } else {
        admin.initializeApp({ projectId });
    }

    return admin;
}

module.exports = { initFirebase };
