#!/usr/bin/env python3
"""Enable HTTPS for a domain on the VPS."""
import os
import sys
import paramiko

HOST = os.environ.get('VPS_HOST', '186.246.12.138')
USER = os.environ.get('VPS_USER', 'root')
PASSWORD = os.environ.get('VPS_PASSWORD', '')
DOMAIN = os.environ.get('DOMAIN', 'volonter-msu.ru')


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

    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    print(f'Connecting to {HOST} for {DOMAIN}...')
    client.connect(HOST, username=USER, password=PASSWORD, timeout=30,
                   look_for_keys=False, allow_agent=False)

    # Upload enable-https.sh content inline
    script = f'''#!/bin/bash
set -euo pipefail
DOMAIN="{DOMAIN}"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq certbot python3-certbot-nginx
cat > /etc/nginx/sites-available/volunteer <<NGX
server {{
    listen 80;
    listen [::]:80;
    server_name ${{DOMAIN}} www.${{DOMAIN}};
    location / {{
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host \\$host;
        proxy_set_header X-Real-IP \\$remote_addr;
        proxy_set_header X-Forwarded-For \\$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \\$scheme;
    }}
}}
NGX
ln -sf /etc/nginx/sites-available/volunteer /etc/nginx/sites-enabled/volunteer
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx
certbot --nginx -d "$DOMAIN" -d "www.$DOMAIN" --non-interactive --agree-tos --register-unsafely-without-email --redirect
echo HTTPS_OK
'''

    sftp = client.open_sftp()
    with sftp.file('/tmp/enable-https.sh', 'w') as f:
        f.write(script)
    sftp.chmod('/tmp/enable-https.sh', 0o755)
    sftp.close()

    code, out = run(client, 'bash /tmp/enable-https.sh', timeout=900)
    run(client, f'curl -sI https://{DOMAIN}/health | head -5 || true')
    client.close()
    sys.exit(0 if code == 0 and 'HTTPS_OK' in out else code)


if __name__ == '__main__':
    main()
