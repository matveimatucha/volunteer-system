#!/usr/bin/env python3
import os
import paramiko

HOST = os.environ.get('VPS_HOST', '186.246.12.138')
PASSWORD = os.environ.get('VPS_PASSWORD', '')

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, username='root', password=PASSWORD, timeout=30,
               look_for_keys=False, allow_agent=False)

cmds = [
    'sleep 2 && curl -s http://127.0.0.1:3000/health',
    'pm2 logs volunteer --lines 20 --nostream 2>&1 | tail -20',
    'bash -lc \'source /var/www/volunteer-system/server/.env 2>/dev/null; curl -s "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getWebhookInfo"\'',
]
for cmd in cmds:
    print('\n>>>', cmd)
    stdin, stdout, stderr = client.exec_command(cmd, get_pty=True, timeout=60)
    print(stdout.read().decode('utf-8', 'replace'))

client.close()
