#!/usr/bin/env python3
"""Remote VPS setup helper (SSH)."""
import os
import sys
import paramiko

HOST = os.environ.get('VPS_HOST', '186.246.12.138')
USER = os.environ.get('VPS_USER', 'root')
PASSWORD = os.environ.get('VPS_PASSWORD', '')
LOCAL_KEY = os.environ.get(
    'LOCAL_SERVICE_ACCOUNT',
    os.path.join(os.path.dirname(__file__), '..', 'server', 'service-account.json')
)
REMOTE_KEY = '/var/www/volunteer-system/server/service-account.json'
ADMIN_EMAIL = os.environ.get('ADMIN_EMAIL', 'volunteer@msuprof.com')
REPO_URL = os.environ.get('REPO_URL', '')


def run(client, cmd, timeout=600):
    print(f'\n>>> {cmd[:120]}...' if len(cmd) > 120 else f'\n>>> {cmd}')
    stdin, stdout, stderr = client.exec_command(cmd, get_pty=True, timeout=timeout)
    out = stdout.read().decode('utf-8', 'replace')
    err = stderr.read().decode('utf-8', 'replace')
    code = stdout.channel.recv_exit_status()
    if out.strip():
        print(out)
    if err.strip():
        print(err, file=sys.stderr)
    print(f'exit={code}')
    return code, out


def main():
    if not PASSWORD:
        print('Set VPS_PASSWORD', file=sys.stderr)
        sys.exit(1)

    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    print(f'Connecting to {HOST}...')
    client.connect(HOST, username=USER, password=PASSWORD, timeout=30,
                   look_for_keys=False, allow_agent=False)

    _, installed = run(client, 'test -d /var/www/volunteer-system/server && echo installed || echo missing')
    if 'missing' in installed:
        hint = (
            'Сайт на сервере ещё не установлен. На сервере выполните '
            'REPO_URL=https://github.com/ОРГАНИЗАЦИЯ/volunteer-system.git bash deploy/vps-setup.sh'
        )
        if REPO_URL:
            hint += f' (REPO_URL уже задан: {REPO_URL})'
        print(hint, file=sys.stderr)
        client.close()
        sys.exit(1)

    if os.path.isfile(LOCAL_KEY):
        print(f'Uploading {LOCAL_KEY}...')
        sftp = client.open_sftp()
        sftp.put(LOCAL_KEY, REMOTE_KEY)
        sftp.chmod(REMOTE_KEY, 0o600)
        sftp.close()
    else:
        print(f'WARN: no local key at {LOCAL_KEY}', file=sys.stderr)

    run(client, f'chmod 600 {REMOTE_KEY} 2>/dev/null; cd /var/www/volunteer-system/server && pm2 restart volunteer')
    run(client, f'cd /var/www/volunteer-system/server && npm run set-admin -- {ADMIN_EMAIL}')
    run(client, 'curl -s http://127.0.0.1:3000/health || true')
    run(client, 'pm2 status || true')
    run(client, 'curl -s ifconfig.me 2>/dev/null || hostname -I')

    client.close()
    print('\nDone. Open https://volunteer.msuprof.com')


if __name__ == '__main__':
    main()
