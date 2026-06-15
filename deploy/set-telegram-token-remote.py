#!/usr/bin/env python3
"""Set TELEGRAM_BOT_TOKEN on VPS and restart pm2 apps."""
import os
import sys
import paramiko

HOST = os.environ.get('VPS_HOST', '186.246.12.138')
USER = os.environ.get('VPS_USER', 'root')
PASSWORD = os.environ.get('VPS_PASSWORD', '')
TOKEN = os.environ.get('TELEGRAM_BOT_TOKEN', '')

APPS = [
    ('/var/www/volunteer-system', 'volunteer', 3000),
    ('/var/www/volunteer-system-staging', 'volunteer-staging', 3001),
]


def run(client, cmd, timeout=180):
    print(f'\n>>> {cmd[:120]}...' if len(cmd) > 120 else f'\n>>> {cmd}')
    stdin, stdout, stderr = client.exec_command(cmd, get_pty=True, timeout=timeout)
    out = stdout.read().decode('utf-8', 'replace')
    err = stderr.read().decode('utf-8', 'replace')
    code = stdout.channel.recv_exit_status()
    if out.strip():
        print(out)
    if err.strip():
        print(err, file=sys.stderr)
    return code, out


def main():
    if not PASSWORD:
        print('Set VPS_PASSWORD', file=sys.stderr)
        sys.exit(1)
    if not TOKEN:
        print('Set TELEGRAM_BOT_TOKEN', file=sys.stderr)
        sys.exit(1)

    token_escaped = TOKEN.replace("'", "'\"'\"'")

    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(HOST, username=USER, password=PASSWORD, timeout=30,
                   look_for_keys=False, allow_agent=False)

    for app_dir, pm2_name, port in APPS:
        print(f'\n=== {app_dir} ===')
        code, _ = run(client, f'cd {app_dir} && git pull && cd server && npm install --omit=dev')
        if code != 0:
            client.close()
            sys.exit(code)

        env_file = f'{app_dir}/server/.env'
        upsert = f"""
TOKEN='{token_escaped}'
ENV_FILE='{env_file}'
touch "$ENV_FILE"
if grep -q '^TELEGRAM_BOT_TOKEN=' "$ENV_FILE"; then
  sed -i "s|^TELEGRAM_BOT_TOKEN=.*|TELEGRAM_BOT_TOKEN=$TOKEN|" "$ENV_FILE"
else
  printf '\\nTELEGRAM_BOT_TOKEN=%s\\n' "$TOKEN" >> "$ENV_FILE"
fi
echo ENV_OK
"""
        code, out = run(client, upsert)
        if code != 0 or 'ENV_OK' not in out:
            client.close()
            sys.exit(1)

        code, out = run(client,
            f'pm2 restart {pm2_name} && sleep 2 && curl -s http://127.0.0.1:{port}/api/telegram/status')
        if code != 0:
            client.close()
            sys.exit(code)

    client.close()
    print('\nDEPLOY_TELEGRAM_OK')


if __name__ == '__main__':
    main()
