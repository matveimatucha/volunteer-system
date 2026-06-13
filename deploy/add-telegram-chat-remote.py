#!/usr/bin/env python3
"""Add Telegram chat IDs to Firestore settings/notifications on VPS."""
import os
import sys
import json
import paramiko

HOST = os.environ.get('VPS_HOST', '186.246.12.138')
PASSWORD = os.environ.get('VPS_PASSWORD', '')
CHAT_IDS = sys.argv[1:] if len(sys.argv) > 1 else []

NODE_SCRIPT = '''
require('dotenv').config();
const { initFirebase } = require('./lib/firebase');
const ids = process.argv.slice(2);
const admin = initFirebase();
const db = admin.firestore();
(async () => {
  const ref = db.collection('settings').doc('notifications');
  const snap = await ref.get();
  const existing = snap.exists && Array.isArray(snap.data().telegramChatIds)
    ? snap.data().telegramChatIds.map(String) : [];
  const merged = [...new Set([...existing, ...ids])];
  await ref.set({
    telegramEnabled: true,
    telegramChatIds: merged,
    updatedAt: new Date().toISOString()
  }, { merge: true });
  console.log('TELEGRAM_CHAT_IDS_OK', JSON.stringify(merged));
})().catch((e) => { console.error(e); process.exit(1); });
'''


def main():
    if not PASSWORD:
        print('Set VPS_PASSWORD', file=sys.stderr)
        sys.exit(1)
    if not CHAT_IDS:
        print('Usage: add-telegram-chat-remote.py CHAT_ID [CHAT_ID...]', file=sys.stderr)
        sys.exit(1)

    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(HOST, username='root', password=PASSWORD, timeout=30,
                   look_for_keys=False, allow_agent=False)

    remote_script = '/var/www/volunteer-system/server/add-telegram-chat-tmp.js'
    ids_args = ' '.join(CHAT_IDS)
    sftp = client.open_sftp()
    with sftp.file(remote_script, 'w') as f:
        f.write(NODE_SCRIPT)
    sftp.close()

    cmd = f'cd /var/www/volunteer-system/server && node add-telegram-chat-tmp.js {ids_args} && rm -f add-telegram-chat-tmp.js'
    stdin, stdout, stderr = client.exec_command(cmd, get_pty=True, timeout=60)
    out = stdout.read().decode('utf-8', 'replace')
    err = stderr.read().decode('utf-8', 'replace')
    code = stdout.channel.recv_exit_status()
    if out.strip():
        print(out)
    if err.strip():
        print(err, file=sys.stderr)
    client.close()
    sys.exit(0 if code == 0 and 'TELEGRAM_CHAT_IDS_OK' in out else code)


if __name__ == '__main__':
    main()
