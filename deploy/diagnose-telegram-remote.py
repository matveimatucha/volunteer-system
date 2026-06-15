#!/usr/bin/env python3
"""Diagnose Telegram + Sheets notification pipeline on VPS."""
import os
import sys
import json
import paramiko

HOST = os.environ.get('VPS_HOST', '186.246.12.138')
PASSWORD = os.environ.get('VPS_PASSWORD', '')

NODE_SCRIPT = r'''
require('dotenv').config();
const { initFirebase } = require('./lib/firebase');
const { resolveSheetsUrl } = require('./lib/sheets-sync');
const { getBotToken, getRecipientChatIds, formatRegistrationMessage } = require('./lib/telegram-notify');

(async () => {
  const admin = initFirebase();
  const db = admin.firestore();

  const token = getBotToken();
  const chatIds = await getRecipientChatIds(db);
  const sheetsUrl = await resolveSheetsUrl(db);

  console.log('DIAG_TOKEN', token ? 'set(len=' + token.length + ')' : 'MISSING');
  console.log('DIAG_CHAT_IDS', JSON.stringify(chatIds));
  console.log('DIAG_SHEETS_URL', sheetsUrl ? 'set(len=' + sheetsUrl.length + ')' : 'MISSING');

  const integ = await db.collection('settings').doc('integrations').get();
  console.log('DIAG_INTEGRATIONS', JSON.stringify(integ.exists ? integ.data() : null));

  const notif = await db.collection('settings').doc('notifications').get();
  console.log('DIAG_NOTIFICATIONS', JSON.stringify(notif.exists ? notif.data() : null));

  const regs = await db.collection('registrations').orderBy('createdAtMs', 'desc').limit(3).get();
  regs.forEach(doc => {
    const d = doc.data();
    console.log('DIAG_REG', doc.id, d.status, d.telegramNotifiedAt || 'no-tg-flag', d.eventTitle || '');
  });

  if (!sheetsUrl || !token || !chatIds.length) {
    console.log('DIAG_BLOCKED missing config');
    process.exit(0);
  }

  const latest = regs.docs[0];
  if (!latest) {
    console.log('DIAG_NO_REGS');
    process.exit(0);
  }

  const text = formatRegistrationMessage(latest.data(), latest.id);
  const payload = JSON.stringify({
    action: 'telegram_notify',
    botToken: token,
    chatIds,
    text,
    regId: latest.id
  });

  const res = await fetch(sheetsUrl, {
    method: 'POST',
    redirect: 'follow',
    headers: { 'Content-Type': 'text/plain' },
    body: payload
  });
  console.log('DIAG_TEST_POST', res.status, (await res.text()).slice(0, 200));
})().catch(e => { console.error('DIAG_ERR', e.message); process.exit(1); });
'''


def main():
    if not PASSWORD:
        print('Set VPS_PASSWORD', file=sys.stderr)
        sys.exit(1)

    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(HOST, username='root', password=PASSWORD, timeout=30,
                   look_for_keys=False, allow_agent=False)

    remote = '/var/www/volunteer-system/server/diag-telegram-tmp.js'
    sftp = client.open_sftp()
    with sftp.file(remote, 'w') as f:
        f.write(NODE_SCRIPT)
    sftp.close()

    cmds = [
        'cd /var/www/volunteer-system/server && node diag-telegram-tmp.js && rm -f diag-telegram-tmp.js',
        'pm2 logs volunteer --lines 40 --nostream 2>&1 | grep -E "telegram|sheets" | tail -25 || true',
    ]
    for cmd in cmds:
        print('\n>>>', cmd[:100])
        stdin, stdout, stderr = client.exec_command(cmd, get_pty=True, timeout=120)
        print(stdout.read().decode('utf-8', 'replace'))
    client.close()


if __name__ == '__main__':
    main()
