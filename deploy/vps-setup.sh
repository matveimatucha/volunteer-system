#!/bin/bash
# Первичная настройка Ubuntu VPS (Timeweb Cloud) для volunteer-system.
# Запуск на сервере: bash vps-setup.sh
set -euo pipefail

APP_DIR="${APP_DIR:-/var/www/volunteer-system}"
REPO_URL="${REPO_URL:-https://github.com/matveimatucha/volunteer-system.git}"
DOMAIN="${DOMAIN:-}"

echo "==> Обновление системы"
apt-get update -qq
apt-get install -y curl git nginx certbot python3-certbot-nginx ufw

echo "==> Node.js 20"
if ! command -v node >/dev/null || [[ "$(node -v | cut -d. -f1 | tr -d v)" -lt 20 ]]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
node -v
npm -v

echo "==> pm2"
npm install -g pm2

echo "==> Клонирование проекта"
mkdir -p "$(dirname "$APP_DIR")"
if [ -d "$APP_DIR/.git" ]; then
  cd "$APP_DIR" && git pull
else
  git clone "$REPO_URL" "$APP_DIR"
  cd "$APP_DIR"
fi

echo "==> Зависимости сервера"
cd "$APP_DIR/server"
npm install --omit=dev

if [ ! -f .env ]; then
  cp .env.example .env
  echo ""
  echo "!!! Создан server/.env — заполните SHEETS_WEBHOOK_URL при необходимости"
  echo "!!! Загрузите service-account.json в $APP_DIR/server/"
fi

if [ ! -f service-account.json ]; then
  echo ""
  echo "!!! НЕТ service-account.json в server/"
  echo "    Загрузите с компьютера (WinSCP/FileZilla):"
  echo "    server/service-account.json"
  echo ""
fi

echo "==> Запуск pm2"
pm2 delete volunteer 2>/dev/null || true
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup systemd -u root --hp /root | tail -1 | bash || true

echo "==> nginx"
NGINX_SITE="/etc/nginx/sites-available/volunteer"
if [ -n "$DOMAIN" ]; then
  SERVER_NAME="$DOMAIN www.$DOMAIN"
else
  SERVER_NAME="_"
fi

cat > "$NGINX_SITE" <<EOF
server {
    listen 80;
    server_name $SERVER_NAME;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}
EOF

ln -sf "$NGINX_SITE" /etc/nginx/sites-enabled/volunteer
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl reload nginx

echo "==> Firewall"
ufw allow OpenSSH
ufw allow 'Nginx Full'
ufw --force enable

echo ""
echo "============================================"
echo " Готово. Проверка: curl http://127.0.0.1:3000/health"
curl -s http://127.0.0.1:3000/health || echo "(сервер ещё не отвечает — проверьте service-account.json)"
echo ""
if [ -n "$DOMAIN" ]; then
  echo " HTTPS: certbot --nginx -d $DOMAIN -d www.$DOMAIN"
else
  echo " Сайт по IP: http://$(curl -s ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}')"
  echo " Когда будет домен: DOMAIN=ваш-домен.ru bash vps-setup.sh && certbot --nginx -d ваш-домен.ru"
fi
echo " Админ-права: cd $APP_DIR/server && npm run set-admin -- ваш@email.com"
echo "============================================"
