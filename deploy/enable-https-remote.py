#!/usr/bin/env python3
"""Enable HTTPS for the new public domain next to the existing site.

Does not issue a www certificate. Does not replace the old nginx site.
For the migration use this (or deploy/enable-new-domain.sh on the server).
Do not run deploy/enable-https.sh during the move: it replaces the old site.
"""
import os
import sys
import paramiko

HOST = os.environ.get('VPS_HOST', '186.246.12.138')
USER = os.environ.get('VPS_USER', 'root')
PASSWORD = os.environ.get('VPS_PASSWORD', '')
DOMAIN = os.environ.get('DOMAIN', 'volunteer.msuprof.com')
LOCAL_SCRIPT = os.path.join(os.path.dirname(__file__), 'enable-new-domain.sh')


def run(client, cmd, timeout=600):
    print(f'\n>>> {cmd[:140]}...' if len(cmd) > 140 else f'\n>>> {cmd}')
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
    if DOMAIN.lower().startswith('www.'):
        print('www is not used. Set DOMAIN=volunteer.msuprof.com', file=sys.stderr)
        sys.exit(1)

    with open(LOCAL_SCRIPT, 'r', encoding='utf-8') as f:
        script = f.read()

    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    print(f'Connecting to {HOST} for {DOMAIN} (no www, old site stays up)...')
    client.connect(HOST, username=USER, password=PASSWORD, timeout=30,
                   look_for_keys=False, allow_agent=False)

    sftp = client.open_sftp()
    with sftp.file('/tmp/enable-new-domain.sh', 'w') as f:
        f.write(script)
    sftp.chmod('/tmp/enable-new-domain.sh', 0o755)
    sftp.close()

    code, out = run(client, f'DOMAIN={DOMAIN} bash /tmp/enable-new-domain.sh', timeout=900)
    run(client, f'curl -sI https://{DOMAIN}/health | head -5 || true')
    client.close()
    sys.exit(0 if code == 0 and 'Новый адрес готов' in out else code)


if __name__ == '__main__':
    main()
