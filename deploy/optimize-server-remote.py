#!/usr/bin/env python3
"""Apply reliability and performance tweaks on the VPS."""
import os
import sys
import paramiko

HOST = os.environ.get('VPS_HOST', '186.246.12.138')
USER = os.environ.get('VPS_USER', 'root')
PASSWORD = os.environ.get('VPS_PASSWORD', '')
DOMAIN = os.environ.get('DOMAIN', 'volonter-msu.ru')
APP_DIR = os.environ.get('APP_DIR', '/var/www/volunteer-system')


def run(client, cmd, timeout=300):
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
APP_DIR="__APP_DIR__"
DOMAIN="__DOMAIN__"

echo "==> swap (защита от нехватки RAM)"
if ! swapon --show | grep -q /swapfile; then
  fallocate -l 1G /swapfile || dd if=/dev/zero of=/swapfile bs=1M count=1024
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  grep -q '/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

echo "==> pm2: автоперезапуск и ротация логов"
cd "$APP_DIR/server"
npm install --omit=dev >/dev/null 2>&1 || true
pm2 install pm2-logrotate >/dev/null 2>&1 || true
pm2 set pm2-logrotate:max_size 10M >/dev/null 2>&1 || true
pm2 set pm2-logrotate:retain 7 >/dev/null 2>&1 || true
pm2 delete volunteer 2>/dev/null || true
pm2 start ecosystem.config.cjs
pm2 save

echo "==> nginx: кэш статики"
rm -f /etc/nginx/conf.d/volunteer-performance.conf
cat > /etc/nginx/sites-available/volunteer <<'NGX'
server {
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name __DOMAIN__ www.__DOMAIN__;

    ssl_certificate /etc/letsencrypt/live/__DOMAIN__/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/__DOMAIN__/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;

    location /assets/ {
        alias __APP_DIR__/assets/;
        access_log off;
        expires 30d;
        add_header Cache-Control "public, immutable";
    }

    location = /health {
        proxy_pass http://127.0.0.1:3000/health;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        access_log off;
    }

    location /api/ {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_connect_timeout 10s;
        proxy_send_timeout 60s;
        proxy_read_timeout 60s;
    }

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_connect_timeout 10s;
        proxy_send_timeout 60s;
        proxy_read_timeout 60s;
    }
}

server {
    listen 80;
    listen [::]:80;
    server_name __DOMAIN__ www.__DOMAIN__;
    return 301 https://$host$request_uri;
}

server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name _;
    return 301 https://__DOMAIN__$request_uri;
}

server {
    listen 443 ssl default_server;
    listen [::]:443 ssl default_server;
    server_name _;
    ssl_certificate /etc/letsencrypt/live/__DOMAIN__/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/__DOMAIN__/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;
    return 301 https://__DOMAIN__$request_uri;
}
NGX
sed -i "s|__DOMAIN__|$DOMAIN|g; s|__APP_DIR__|$APP_DIR|g" /etc/nginx/sites-available/volunteer

ln -sf /etc/nginx/sites-available/volunteer /etc/nginx/sites-enabled/volunteer
rm -f /etc/nginx/sites-enabled/volunteer-default
nginx -t
systemctl reload nginx

echo "==> проверка"
curl -s http://127.0.0.1:3000/health
echo
curl -skI https://127.0.0.1/health -H "Host: $DOMAIN" | head -5
echo OPTIMIZE_OK
'''
    script = script.replace('__APP_DIR__', APP_DIR).replace('__DOMAIN__', DOMAIN)

    sftp = client.open_sftp()
    with sftp.file('/tmp/optimize-server.sh', 'w') as f:
        f.write(script)
    sftp.chmod('/tmp/optimize-server.sh', 0o755)
    sftp.close()

    # Upload updated ecosystem config
    local_eco = os.path.join(os.path.dirname(__file__), '..', 'server', 'ecosystem.config.cjs')
    with open(local_eco, 'r', encoding='utf-8') as f:
        eco_content = f.read()
    sftp = client.open_sftp()
    with sftp.file(f'{APP_DIR}/server/ecosystem.config.cjs', 'w') as f:
        f.write(eco_content)
    sftp.close()

    code, out = run(client, 'bash /tmp/optimize-server.sh', timeout=600)
    client.close()
    sys.exit(0 if code == 0 and 'OPTIMIZE_OK' in out else code)


if __name__ == '__main__':
    main()
