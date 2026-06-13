#!/usr/bin/env python3
"""Update production site from git and restart pm2."""
import os
import sys
import paramiko

HOST = os.environ.get('VPS_HOST', '186.246.12.138')
USER = os.environ.get('VPS_USER', 'root')
PASSWORD = os.environ.get('VPS_PASSWORD', '')
PROD_DIR = os.environ.get('APP_DIR', '/var/www/volunteer-system')


def run(client, cmd, timeout=300):
    print(f'\n>>> {cmd}')
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
    client.connect(HOST, username=USER, password=PASSWORD, timeout=30,
                   look_for_keys=False, allow_agent=False)

    cmd = f'''
set -e
cd {PROD_DIR}
git pull
cd server
npm install --omit=dev
pm2 restart volunteer
curl -s http://127.0.0.1:3000/health
echo
echo UPDATE_PROD_OK
'''
    code, out = run(client, cmd)
    client.close()
    sys.exit(0 if code == 0 and 'UPDATE_PROD_OK' in out else code)


if __name__ == '__main__':
    main()
