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
  assert.match(indexHtml, /isWaitlistOnly \? 'Лист ожидания'/);
  assert.match(indexHtml, /\$\{!canRegister \? 'disabled' : ''\}/);
  assert.match(indexHtml, /status !== 'draft' && e\.isTemplate !== true/);
  assert.match(indexHtml, /isEventArchived\(e, today\)/);
  assert.match(indexHtml, /volunteer_events_v2/);
});

test('register.html uses transaction to prevent oversubscription', async () => {
  const registerHtml = await readProjectFile('register.html');

  assert.match(registerHtml, /await db\.runTransaction\(async \(transaction\) => \{/);
  assert.match(registerHtml, /const savingAsWaitlist = isWaitlist \|\| latestCurrent >= latestMax;/);
  assert.match(registerHtml, /if \(!savingAsWaitlist\) \{/);
  assert.match(registerHtml, /throw new Error\('REGISTRATION_CLOSED'\);/);
  assert.match(registerHtml, /transaction\.update\(eventRef, \{\s*currentVolunteers: firebase\.firestore\.FieldValue\.increment\(1\)/m);
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
  assert.match(adminHtml, /ALLOWED_ADMIN_EMAILS/);
  assert.match(adminHtml, /firebase-auth-compat/);
  assert.match(adminHtml, /deleteRegistration/);
  assert.match(adminHtml, /promoteFromWaitlist/);
  assert.match(adminHtml, /onclick="exportCSV\('new'\)"/);
  assert.match(adminHtml, /onclick="exportCSV\('all'\)"/);
  assert.match(adminHtml, /function exportCSV\(mode = 'all'\)/);
  assert.match(adminHtml, /'contactPhone', \.\.\.headerKeys/);
  assert.match(adminHtml, /syncVolunteerCount/);
  assert.match(adminHtml, /dateRaw:/);
});
