#!/bin/bash
# Однострочная установка для Timeweb VPS (Ubuntu).
# На сервере: curl -fsSL ... | bash
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
APP_DIR=/var/www/volunteer-system
REPO=https://github.com/matveimatucha/volunteer-system.git

apt-get update -qq
apt-get install -y -qq curl git nginx ufw
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y -qq nodejs
npm install -g pm2

mkdir -p "$(dirname "$APP_DIR")"
if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" pull --ff-only
else
  git clone "$REPO" "$APP_DIR"
fi

cd "$APP_DIR/server"
npm install --omit=dev
[ -f .env ] || cp .env.example .env

pm2 delete volunteer 2>/dev/null || true
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup systemd -u root --hp /root 2>/dev/null | tail -1 | bash || true

cat > /etc/nginx/sites-available/volunteer <<'NGX'
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name _;
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
NGX
ln -sf /etc/nginx/sites-available/volunteer /etc/nginx/sites-enabled/volunteer
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx

ufw allow OpenSSH
ufw allow 'Nginx Full'
ufw --force enable

echo ""
echo "=== Установка завершена ==="
echo "Сайт (после загрузки service-account.json): http://$(curl -s ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}')"
echo "Дальше с компьютера: .\\deploy\\upload-secrets.ps1 -ServerIp ВАШ_IP"
