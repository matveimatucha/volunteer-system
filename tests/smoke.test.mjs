import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const ROOT = new URL('../', import.meta.url);

async function readProjectFile(fileName) {
  return readFile(new URL(fileName, ROOT), 'utf8');
}

test('index.html blocks signup for closed events', async () => {
  const indexHtml = await readProjectFile('index.html');

  assert.match(indexHtml, /const isClosed = \(event\.status \|\| 'open'\) === 'closed' \|\| event\.isArchived === true;/);
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
});

test('standalone VPS server exposes the same API routes', async () => {
  const serverApp = await readProjectFile('server/lib/create-app.js');

  assert.match(serverApp, /router\.get\('\/events'/);
  assert.match(serverApp, /router\.post\('\/registrations'/);
  assert.match(serverApp, /scheduleSheetsSync/);
  assert.match(serverApp, /pickFirstWaitlistDoc/);
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
  assert.match(adminHtml, /'contactPhone', \.\.\.headerKeys/);
  assert.match(adminHtml, /syncVolunteerCount/);
  assert.match(adminHtml, /dateRaw:/);
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
});
