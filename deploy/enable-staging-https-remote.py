#!/usr/bin/env python3
"""Enable HTTPS for staging subdomain on VPS."""
import os
import sys
import paramiko

HOST = os.environ.get('VPS_HOST', '186.246.12.138')
USER = os.environ.get('VPS_USER', 'root')
PASSWORD = os.environ.get('VPS_PASSWORD', '')
STAGING_HOST = os.environ.get('STAGING_HOST', 'staging.volonter-msu.ru')
STAGING_DIR = os.environ.get('STAGING_DIR', '/var/www/volunteer-system-staging')


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
    client.connect(HOST, username=USER, password=PASSWORD, timeout=30,
                   look_for_keys=False, allow_agent=False)

    script = '''#!/bin/bash
set -euo pipefail
STAGING_HOST="__STAGING_HOST__"
STAGING_DIR="__STAGING_DIR__"

cat > /etc/nginx/sites-available/volunteer-staging <<'NGX'
server {
    listen 80;
    listen [::]:80;
    server_name __STAGING_HOST__;

    add_header X-Robots-Tag "noindex, nofollow" always;

    location /assets/ {
        alias __STAGING_DIR__/assets/;
        access_log off;
        expires 1h;
    }

    location / {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
NGX
sed -i "s|__STAGING_HOST__|$STAGING_HOST|g; s|__STAGING_DIR__|$STAGING_DIR|g" /etc/nginx/sites-available/volunteer-staging
ln -sf /etc/nginx/sites-available/volunteer-staging /etc/nginx/sites-enabled/volunteer-staging
nginx -t
systemctl reload nginx
certbot --nginx -d "$STAGING_HOST" --non-interactive --agree-tos --register-unsafely-without-email --redirect
curl -skI "https://$STAGING_HOST/health" | head -6
echo STAGING_HTTPS_OK
'''
    script = script.replace('__STAGING_HOST__', STAGING_HOST).replace('__STAGING_DIR__', STAGING_DIR)

    sftp = client.open_sftp()
    with sftp.file('/tmp/enable-staging-https.sh', 'w') as f:
        f.write(script)
    sftp.chmod('/tmp/enable-staging-https.sh', 0o755)
    sftp.close()

    code, out = run(client, 'bash /tmp/enable-staging-https.sh', timeout=900)
    client.close()
    sys.exit(0 if code == 0 and 'STAGING_HTTPS_OK' in out else code)


if __name__ == '__main__':
    main()
