import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

const ROOT = new URL('../', import.meta.url);
const require = createRequire(import.meta.url);

async function readProjectFile(fileName) {
  return readFile(new URL(fileName, ROOT), 'utf8');
}

test('index.html blocks signup for closed events', async () => {
  const indexHtml = await readProjectFile('index.html');

  assert.match(indexHtml, /const isClosed = \(event\.status \|\| 'open'\) === 'closed' \|\| event\.isArchived === true \|\| isPastEvent;/);
  assert.match(indexHtml, /const canRegister = !isClosed && \(isUnlimited \|\| spotsLeft > 0 \|\| isWaitlistOnly\);/);
  assert.match(indexHtml, /isWaitlistOnly \? '.* Лист ожидания'/);
  assert.match(indexHtml, /\$\{!canRegister \? 'disabled' : ''\}/);
  assert.match(indexHtml, /status !== 'draft' && e\.isTemplate !== true/);
  assert.match(indexHtml, /isEventArchived\(e, today\)/);
  assert.match(indexHtml, /volunteer_events_v2/);
});

test('register.html submits registrations through the server API', async () => {
  const registerHtml = await readProjectFile('register.html');

  assert.match(registerHtml, /apiUrl\('\/api\/registrations'/);
  assert.match(registerHtml, /method: 'POST'/);
  assert.match(registerHtml, /result\.cancelToken/);
  assert.doesNotMatch(registerHtml, /db\.runTransaction/);
  assert.doesNotMatch(registerHtml, /firebase-firestore-compat/);
  assert.match(registerHtml, /assets\/api-config\.js/);
});

test('server API prevents oversubscription inside a transaction', async () => {
  const functionsIndex = await readProjectFile('functions/index.js');

  assert.match(functionsIndex, /db\.runTransaction\(async \(transaction\) => \{/);
  assert.match(functionsIndex, /const savingAsWaitlist = wantsWaitlist \|\| current >= max;/);
  assert.match(functionsIndex, /REGISTRATION_CLOSED/);
  assert.match(functionsIndex, /DUPLICATE_EMAIL/);
  assert.match(functionsIndex, /DUPLICATE_PHONE/);
  assert.match(functionsIndex, /currentVolunteers: admin\.firestore\.FieldValue\.increment\(1\)/);
  assert.match(functionsIndex, /cancelToken/);
  assert.match(functionsIndex, /pickFirstWaitlistDoc/);
  assert.match(functionsIndex, /REGISTRATION_STATUS\.WAITLIST/);
  assert.match(functionsIndex, /MISSING_DAYS/);
  assert.match(functionsIndex, /selectedDays/);
});

test('standalone VPS server exposes the same API routes', async () => {
  const serverApp = await readProjectFile('server/lib/create-app.js');

  assert.match(serverApp, /router\.get\('\/events'/);
  assert.match(serverApp, /router\.post\('\/registrations'/);
  assert.match(serverApp, /scheduleSheetsSync/);
  assert.match(serverApp, /pickFirstWaitlistDoc/);
  assert.match(serverApp, /assertRequiredAnswers/);
  assert.match(serverApp, /vacateConfirmedSpot/);
  assert.match(serverApp, /assertCancelToken/);
  assert.match(serverApp, /RATE_LIMIT/);
  assert.match(serverApp, /MISSING_DAYS/);
  assert.match(serverApp, /dateEndRaw/);
});

test('multi-day events stay open until the last day', () => {
  const helpers = require('../functions/lib/registration-helpers.js');
  const event = { dateRaw: '2026-09-01', dateEndRaw: '2026-09-10' };

  assert.equal(helpers.isMultiDayEvent(event), true);
  assert.equal(helpers.isEventDatePassed(event, new Date(2026, 8, 10)), false);
  assert.equal(helpers.isEventDatePassed(event, new Date(2026, 8, 11)), true);
  assert.deepEqual(helpers.enumerateEventDays(event).slice(0, 3), ['2026-09-01', '2026-09-02', '2026-09-03']);
  assert.deepEqual(
    helpers.sanitizeSelectedDays(['2026-09-02', 'nope', '2026-09-02', '2026-09-11'], event),
    ['2026-09-02']
  );
  assert.equal(helpers.isMultiDayEvent({ dateRaw: '2026-09-01' }), false);
});

test('registration helpers close past-dated events', async () => {
  const helpers = await readProjectFile('functions/lib/registration-helpers.js');

  assert.match(helpers, /function isEventDatePassed/);
  assert.match(helpers, /function isFirstNameQuestion/);
  assert.match(helpers, /isEventDatePassed\(event\)/);
  assert.match(helpers, /function enumerateEventDays/);
  assert.match(helpers, /function sanitizeSelectedDays/);
  assert.match(helpers, /dateEndRaw/);
});

test('firebase hosting redirect folder exists', async () => {
  const firebaseJson = await readProjectFile('firebase.json');
  const redirectPage = await readProjectFile('deploy/hosting-redirect/index.html');

  assert.match(firebaseJson, /deploy\/hosting-redirect/);
  assert.match(redirectPage, /volonter-msu\.ru/);
});

test('server entry serves static files and health check', async () => {
  const serverIndex = await readProjectFile('server/index.js');

  assert.match(serverIndex, /express\.static/);
  assert.match(serverIndex, /\/health/);
  assert.match(serverIndex, /GOOGLE_APPLICATION_CREDENTIALS/);
});

test('firestore rules deny client writes', async () => {
  const rules = await readProjectFile('firestore.rules');

  assert.match(rules, /match \/events\/\{eventId\} \{/);
  assert.match(rules, /allow write: if false;/);
  assert.match(rules, /match \/registrations\/\{registrationId\} \{/);
  assert.match(rules, /allow read, write: if false;/);
  assert.doesNotMatch(rules, /allow read, write: if true;/);
});

test('register.html resolves reply_to from real email answers', async () => {
  const registerHtml = await readProjectFile('register.html');

  assert.match(registerHtml, /collectAnswersFromForm\(form, questions\)/);
  assert.match(registerHtml, /reply_to:\s+contactEmail/);
  assert.match(registerHtml, /answersLabeled/);
  assert.match(registerHtml, /DUPLICATE_PHONE/);
  assert.match(registerHtml, /REGISTRATION_STATUS\.WAITLIST/);
  assert.match(registerHtml, /data-waitlist/);
  assert.match(registerHtml, /function showSuccessScreen\(event, options = \{\}\)/);
});

test('admin.html template count message is consistent', async () => {
  const adminHtml = await readProjectFile('admin.html');

  assert.match(adminHtml, /Добавлены 10 базовых вопросов/);
  assert.match(adminHtml, /deleteRegistration/);
  assert.match(adminHtml, /promoteFromWaitlist/);
  assert.match(adminHtml, /onclick="exportCSV\('new'\)"/);
  assert.match(adminHtml, /onclick="exportCSV\('all'\)"/);
  assert.match(adminHtml, /function exportCSV\(mode = 'all'\)/);
  assert.match(adminHtml, /'contactPhone', 'selectedDays', 'attendance', 'workedHours', \.\.\.headerKeys/);
  assert.match(adminHtml, /syncVolunteerCount/);
  assert.match(adminHtml, /dateRaw:/);
  assert.match(adminHtml, /dateEndRaw:/);
  assert.match(adminHtml, /id="eventDateEnd"/);
  assert.match(adminHtml, /setParticipantsDayFilter/);
});

test('admin.html uses Firebase Auth and the admin API', async () => {
  const adminHtml = await readProjectFile('admin.html');

  assert.match(adminHtml, /firebase-auth-compat/);
  assert.match(adminHtml, /signInWithEmailAndPassword/);
  assert.match(adminHtml, /tokenResult\.claims\.admin === true/);
  assert.match(adminHtml, /tokenResult\.claims\.superadmin === true/);
  assert.match(adminHtml, /apiFetch\('\/api\/admin\/events'\)/);
  assert.doesNotMatch(adminHtml, /const ADMIN_PASSWORD = '/);
  assert.doesNotMatch(adminHtml, /firebase-firestore-compat/);
});

test('admin.html has dashboard and export-all', async () => {
  const adminHtml = await readProjectFile('admin.html');

  assert.match(adminHtml, /function loadDashboard\(\)/);
  assert.match(adminHtml, /function exportAllCSV\(\)/);
  assert.match(adminHtml, /copyConfirmedEmails/);
});

test('index.html has search and filters', async () => {
  const indexHtml = await readProjectFile('index.html');

  assert.match(indexHtml, /id="eventSearch"/);
  assert.match(indexHtml, /function applyEventFilters\(\)/);
});

test('register.html offers calendar and self-cancel links', async () => {
  const registerHtml = await readProjectFile('register.html');

  assert.match(registerHtml, /function downloadIcs\(\)/);
  assert.match(registerHtml, /buildCancelUrl/);
  assert.match(registerHtml, /buildCalendarLinks/);
  assert.match(registerHtml, /Перейти в чат/);
});

test('registration-utils still provides calendar links helper', async () => {
  const utils = await readProjectFile('assets/registration-utils.js');

  assert.match(utils, /buildCalendarLinks/);
});

test('cancel.html allows participants to cancel their registration', async () => {
  const cancelHtml = await readProjectFile('cancel.html');

  assert.match(cancelHtml, /async function doCancel\(\)/);
  assert.match(cancelHtml, /apiUrl\(`\/api\/registrations\/\$\{encodeURIComponent\(registrationId\)\}\/cancel`\)/);
  assert.match(cancelHtml, /token: cancelToken/);
  assert.doesNotMatch(cancelHtml, /db\.runTransaction/);
  assert.match(cancelHtml, /assets\/api-config\.js/);
});

test('registration-utils exposes calendar helpers and cancelled status', async () => {
  const utils = await readProjectFile('assets/registration-utils.js');

  assert.match(utils, /function buildCalendarLinks\(event\)/);
  assert.match(utils, /CANCELLED: 'cancelled'/);
  assert.match(utils, /function isCancelledRegistration/);
  assert.match(utils, /function formatEventDateRange/);
  assert.match(utils, /function enumerateEventDays/);
});

test('register.html lets volunteers pick days in a range', async () => {
  const registerHtml = await readProjectFile('register.html');

  assert.match(registerHtml, /function generateDaysPicker/);
  assert.match(registerHtml, /name="selectedDays"/);
  assert.match(registerHtml, /MISSING_DAYS/);
});
