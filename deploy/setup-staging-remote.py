#!/usr/bin/env python3
"""Create staging environment on VPS (staging.volonter-msu.ru)."""
import os
import sys
import paramiko

HOST = os.environ.get('VPS_HOST', '186.246.12.138')
USER = os.environ.get('VPS_USER', 'root')
PASSWORD = os.environ.get('VPS_PASSWORD', '')
DOMAIN = os.environ.get('DOMAIN', 'volonter-msu.ru')
STAGING_HOST = os.environ.get('STAGING_HOST', f'staging.{DOMAIN}')
PROD_DIR = os.environ.get('APP_DIR', '/var/www/volunteer-system')
STAGING_DIR = os.environ.get('STAGING_DIR', '/var/www/volunteer-system-staging')
REPO_URL = os.environ.get('REPO_URL', 'https://github.com/matveimatucha/volunteer-system.git')


def run(client, cmd, timeout=600):
    print(f'\n>>> {cmd[:160]}...' if len(cmd) > 160 else f'\n>>> {cmd}')
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
PROD_DIR="__PROD_DIR__"
STAGING_DIR="__STAGING_DIR__"
STAGING_HOST="__STAGING_HOST__"
DOMAIN="__DOMAIN__"
REPO_URL="__REPO_URL__"

echo "==> staging app directory"
if [ -d "$STAGING_DIR/.git" ]; then
  cd "$STAGING_DIR" && git pull
else
  git clone "$REPO_URL" "$STAGING_DIR"
  cd "$STAGING_DIR"
fi

echo "==> secrets and env"
mkdir -p "$STAGING_DIR/server"
if [ -f "$PROD_DIR/server/service-account.json" ]; then
  cp "$PROD_DIR/server/service-account.json" "$STAGING_DIR/server/service-account.json"
  chmod 600 "$STAGING_DIR/server/service-account.json"
fi
cat > "$STAGING_DIR/server/.env" <<ENV
PORT=3001
STAGING=true
GOOGLE_APPLICATION_CREDENTIALS=./service-account.json
FIREBASE_PROJECT_ID=volunteer-system-6ce7f
ENV
if [ -f "$PROD_DIR/server/.env" ]; then
  grep SHEETS_WEBHOOK_URL "$PROD_DIR/server/.env" >> "$STAGING_DIR/server/.env" 2>/dev/null || true
fi

echo "==> dependencies and pm2"
cd "$STAGING_DIR/server"
npm install --omit=dev
pm2 delete volunteer-staging 2>/dev/null || true
pm2 start ecosystem.staging.config.cjs
pm2 save

echo "==> nginx staging"
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

echo "==> HTTPS (если DNS уже указывает на сервер)"
if getent hosts "$STAGING_HOST" >/dev/null 2>&1; then
  certbot --nginx -d "$STAGING_HOST" --non-interactive --agree-tos --register-unsafely-without-email --redirect || true
else
  echo "DNS для $STAGING_HOST ещё не виден — HTTPS позже"
fi

echo "==> check"
curl -s http://127.0.0.1:3001/health || true
echo
curl -sI "http://127.0.0.1/" -H "Host: $STAGING_HOST" | head -5 || true
echo STAGING_OK
'''
    script = (
        script.replace('__PROD_DIR__', PROD_DIR)
        .replace('__STAGING_DIR__', STAGING_DIR)
        .replace('__STAGING_HOST__', STAGING_HOST)
        .replace('__DOMAIN__', DOMAIN)
        .replace('__REPO_URL__', REPO_URL)
    )

    sftp = client.open_sftp()
    with sftp.file('/tmp/setup-staging.sh', 'w') as f:
        f.write(script)
    sftp.chmod('/tmp/setup-staging.sh', 0o755)
    sftp.close()

    code, out = run(client, 'bash /tmp/setup-staging.sh', timeout=900)
    client.close()
    sys.exit(0 if code == 0 and 'STAGING_OK' in out else code)


if __name__ == '__main__':
    main()
