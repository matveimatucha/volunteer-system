#!/usr/bin/env python3
"""Copy SHEETS_WEBHOOK_URL from server .env into Firestore settings/integrations."""
import os
import re
import sys
import paramiko

HOST = os.environ.get('VPS_HOST', '186.246.12.138')
PASSWORD = os.environ.get('VPS_PASSWORD', '')

NODE_SCRIPT = '''
require('dotenv').config();
const { initFirebase } = require('./lib/firebase');
const url = (process.env.SHEETS_WEBHOOK_URL || '').trim();
if (!url) { console.log('NO_SHEETS_URL'); process.exit(0); }
const admin = initFirebase();
const db = admin.firestore();
(async () => {
  await db.collection('settings').doc('integrations').set({
    sheetsWebhookUrl: url,
    updatedAt: new Date().toISOString()
  }, { merge: true });
  console.log('INTEGRATIONS_OK');
})().catch((e) => { console.error(e); process.exit(1); });
'''


def main():
    if not PASSWORD:
        print('Set VPS_PASSWORD', file=sys.stderr)
        sys.exit(1)

    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(HOST, username='root', password=PASSWORD, timeout=30,
                   look_for_keys=False, allow_agent=False)

    remote = '/var/www/volunteer-system/server/sync-integrations-tmp.js'
    sftp = client.open_sftp()
    with sftp.file(remote, 'w') as f:
        f.write(NODE_SCRIPT)
    sftp.close()

    stdin, stdout, stderr = client.exec_command(
        f'cd /var/www/volunteer-system/server && node sync-integrations-tmp.js && rm -f sync-integrations-tmp.js',
        get_pty=True, timeout=60
    )
    out = stdout.read().decode('utf-8', 'replace')
    print(out)
    client.close()
    if 'INTEGRATIONS_OK' in out:
        sys.exit(0)
    if 'NO_SHEETS_URL' in out:
        print('SHEETS_WEBHOOK_URL пуст в server/.env — сохраните URL таблицы в админке')
        sys.exit(0)
    sys.exit(1)


if __name__ == '__main__':
    main()
