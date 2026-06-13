#!/usr/bin/env python3
"""Update staging site from git and restart pm2."""
import os
import sys
import paramiko

HOST = os.environ.get('VPS_HOST', '186.246.12.138')
USER = os.environ.get('VPS_USER', 'root')
PASSWORD = os.environ.get('VPS_PASSWORD', '')
STAGING_DIR = os.environ.get('STAGING_DIR', '/var/www/volunteer-system-staging')


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
cd {STAGING_DIR}
git pull
cd server
npm install --omit=dev
pm2 restart volunteer-staging
curl -s http://127.0.0.1:3001/health
echo
echo UPDATE_STAGING_OK
'''
    code, out = run(client, cmd)
    client.close()
    sys.exit(0 if code == 0 and 'UPDATE_STAGING_OK' in out else code)


if __name__ == '__main__':
    main()
