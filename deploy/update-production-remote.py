#!/usr/bin/env python3
"""Update production site from git and restart pm2."""
import os
import sys
import time
import paramiko

HOST = os.environ.get('VPS_HOST', '186.246.12.138')
USER = os.environ.get('VPS_USER', 'root')
PASSWORD = os.environ.get('VPS_PASSWORD', '')
PROD_DIR = os.environ.get('APP_DIR', '/var/www/volunteer-system')


def safe_print(text, stream=None):
    stream = stream or sys.stdout
    encoding = getattr(stream, 'encoding', None) or 'utf-8'
    try:
        print(text, file=stream)
    except UnicodeEncodeError:
        stream.buffer.write((text + '\n').encode(encoding, errors='replace'))


def run(client, cmd, timeout=300):
    print(f'\n>>> {cmd}')
    stdin, stdout, stderr = client.exec_command(cmd, get_pty=True, timeout=timeout)
    out = stdout.read().decode('utf-8', 'replace')
    err = stderr.read().decode('utf-8', 'replace')
    code = stdout.channel.recv_exit_status()
    if out.strip():
        safe_print(out)
    if err.strip():
        safe_print(err, sys.stderr)
    print(f'exit={code}')
    return code, out


def connect_client():
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    last_error = None
    for attempt in range(1, 4):
        try:
            client.connect(HOST, username=USER, password=PASSWORD, timeout=60,
                           look_for_keys=False, allow_agent=False)
            return client
        except Exception as error:
            last_error = error
            safe_print(f'SSH connect attempt {attempt} failed: {error}', sys.stderr)
            if attempt < 3:
                time.sleep(5)
    raise last_error


def main():
    if not PASSWORD:
        print('Set VPS_PASSWORD', file=sys.stderr)
        sys.exit(1)

    client = connect_client()

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
