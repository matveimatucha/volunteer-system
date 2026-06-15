#!/usr/bin/env python3
import os
import re
import paramiko

HOST = os.environ.get('VPS_HOST', '186.246.12.138')
PASSWORD = os.environ.get('VPS_PASSWORD', '')
ENV_FILE = '/var/www/volunteer-system/server/.env'
WEBHOOK_URL = 'https://volonter-msu.ru/api/telegram/webhook'


def run(client, cmd):
    stdin, stdout, stderr = client.exec_command(cmd, get_pty=True, timeout=60)
    out = stdout.read().decode('utf-8', 'replace')
    err = stderr.read().decode('utf-8', 'replace')
    code = stdout.channel.recv_exit_status()
    if out.strip():
        print(out)
    if err.strip():
        print(err)
    return code, out


def main():
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(HOST, username='root', password=PASSWORD, timeout=30,
                   look_for_keys=False, allow_agent=False)

    _, env_text = run(client, f'cat {ENV_FILE}')
    m = re.search(r'^TELEGRAM_BOT_TOKEN=(.+)$', env_text, re.M)
    if not m:
        print('TELEGRAM_BOT_TOKEN not found in .env')
        client.close()
        return 1

    token = m.group(1).strip().strip('"').strip("'")
    payload = f'{{"url":"{WEBHOOK_URL}","allowed_updates":["message"]}}'
    cmd = (
        f"curl -s -X POST 'https://api.telegram.org/bot{token}/setWebhook' "
        f"-H 'Content-Type: application/json' -d '{payload}'"
    )
    print('>>> setWebhook')
    run(client, cmd)
    print('>>> getWebhookInfo')
    run(client, f"curl -s 'https://api.telegram.org/bot{token}/getWebhookInfo'")
    client.close()
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
