/**
 * Автономный сервер для российского VPS (Timeweb, Selectel, Beget и т.д.).
 *
 * Раздаёт статику сайта и API /api/** на одном порту.
 * База и авторизация админа — Firebase (Spark, бесплатно), через service account.
 */

require('dotenv').config();

const path = require('path');
const fs = require('fs');
const express = require('express');
const { initFirebase } = require('./lib/firebase');
const { createApp } = require('./lib/create-app');
const { startWatchers } = require('./lib/registration-watcher');
const { ensureTelegramWebhook } = require('./lib/telegram-notify');

const PORT = Number(process.env.PORT) || 3000;
const STATIC_ROOT = path.resolve(
    process.cwd(),
    process.env.STATIC_ROOT || '..'
);

function readSiteUpdateNote() {
    try {
        const raw = fs.readFileSync(path.join(STATIC_ROOT, 'assets', 'update-notes.json'), 'utf8');
        const data = JSON.parse(raw);
        return String(data && data.note ? data.note : '').trim().slice(0, 200);
    } catch {
        return '';
    }
}

const SITE_UPDATED_AT = new Date().toISOString();
const SITE_UPDATE_NOTE = readSiteUpdateNote();

const admin = initFirebase();
const db = admin.firestore();
const apiApp = createApp({ admin, db });

const rootApp = express();
rootApp.set('trust proxy', 1);

const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

if (allowedOrigins.length) {
    rootApp.use((req, res, next) => {
        const origin = req.headers.origin;
        if (origin && allowedOrigins.includes(origin)) {
            res.setHeader('Access-Control-Allow-Origin', origin);
            res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
            res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
        }
        if (req.method === 'OPTIONS') {
            res.sendStatus(204);
            return;
        }
        next();
    });
}

rootApp.get('/health', (req, res) => {
    res.json({
        ok: true,
        mode: process.env.STAGING === 'true' ? 'staging-server' : 'standalone-server',
        updatedAt: SITE_UPDATED_AT,
        note: SITE_UPDATE_NOTE
    });
});

// Только /api/** — иначе catch-all API отдаёт JSON 404 на admin.html и другие страницы
rootApp.use('/api', apiApp);

const staticBlocklist = new Set([
    'server',
    'functions',
    'node_modules',
    'tests',
    'deploy',
    '.git',
    '.github',
    '.env'
]);

rootApp.use((req, res, next) => {
    if (req.path.startsWith('/api')) return next();
    const segment = req.path.split('/').filter(Boolean)[0];
    if (segment && staticBlocklist.has(segment)) {
        res.status(404).end();
        return;
    }
    next();
});

rootApp.use(express.static(STATIC_ROOT, {
    index: 'index.html',
    extensions: ['html']
}));

rootApp.listen(PORT, () => {
    console.log(`Volunteer server: http://localhost:${PORT}`);
    console.log(`Static root: ${STATIC_ROOT}`);
    if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
        console.warn('WARN: GOOGLE_APPLICATION_CREDENTIALS не задан — Firestore/Auth могут не работать');
    }
    startWatchers(db, console);
    if (process.env.STAGING !== 'true') {
        ensureTelegramWebhook(console).catch((err) => {
            console.error('[telegram] webhook setup failed', err.message);
        });
    }
});
