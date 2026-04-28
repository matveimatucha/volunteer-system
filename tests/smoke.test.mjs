import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const ROOT = new URL('../', import.meta.url);

async function readProjectFile(fileName) {
  return readFile(new URL(fileName, ROOT), 'utf8');
}

test('index.html blocks signup for closed events', async () => {
  const indexHtml = await readProjectFile('index.html');

  assert.match(indexHtml, /const isClosed = \(event\.status \|\| 'open'\) === 'closed';/);
  assert.match(indexHtml, /const canRegister = spotsLeft > 0 && !isClosed;/);
  assert.match(indexHtml, /\$\{isClosed \? 'Регистрация закрыта' : \(spotsLeft > 0 \? 'Записаться' : 'Заполнено'\)\}/);
});

test('register.html uses transaction to prevent oversubscription', async () => {
  const registerHtml = await readProjectFile('register.html');

  assert.match(registerHtml, /await db\.runTransaction\(async \(transaction\) => \{/);
  assert.match(registerHtml, /if \(isClosed \|\| latestCurrent >= latestMax\) \{/);
  assert.match(registerHtml, /throw new Error\('REGISTRATION_CLOSED'\);/);
  assert.match(registerHtml, /transaction\.update\(eventRef, \{\s*currentVolunteers: firebase\.firestore\.FieldValue\.increment\(1\)/m);
});

test('register.html resolves reply_to from real email answers', async () => {
  const registerHtml = await readProjectFile('register.html');

  assert.match(registerHtml, /function findReplyToEmail\(answers\) \{/);
  assert.match(registerHtml, /reply_to:\s+findReplyToEmail\(answers\)/);
});

test('admin.html template count message is consistent', async () => {
  const adminHtml = await readProjectFile('admin.html');

  assert.match(adminHtml, /Добавлены 9 базовых вопросов/);
});
