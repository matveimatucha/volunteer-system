#!/bin/bash
# Добавляет HTTPS для нового адреса РЯДОМ со старым сайтом.
# Старый volonter-msu.ru не выключается и не редиректится.
# www не используется и в сертификат не попадает.
#
# На сервере, когда DNS volunteer.msuprof.com уже смотрит на этот IP:
#   bash /var/www/volunteer-system/deploy/enable-new-domain.sh
set -euo pipefail

DOMAIN="${DOMAIN:-volunteer.msuprof.com}"
APP_DIR="${APP_DIR:-/var/www/volunteer-system}"
SITE_FILE="/etc/nginx/sites-available/volunteer-msuprof"
CERTBOT_EMAIL="${CERTBOT_EMAIL:-volunteer@msuprof.com}"

if [[ "$DOMAIN" == www.* ]]; then
  echo "www не используется. Нужен DOMAIN=volunteer.msuprof.com"
  exit 1
fi

if [[ "$(echo "$DOMAIN" | tr '[:upper:]' '[:lower:]')" == *www.volunteer.msuprof.com* ]]; then
  echo "www.volunteer.msuprof.com не нужен. Оставьте volunteer.msuprof.com"
  exit 1
fi

if ! getent hosts "$DOMAIN" >/dev/null 2>&1; then
  echo "DNS для $DOMAIN ещё не виден с этого сервера."
  echo "Сначала: nslookup $DOMAIN  — должен быть IP этого VPS."
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq certbot python3-certbot-nginx

# Отдельный файл. Существующий /etc/nginx/sites-available/volunteer не трогаем.
cat > "$SITE_FILE" <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name ${DOMAIN};

    location /assets/ {
        alias ${APP_DIR}/assets/;
        access_log off;
        expires 30d;
        add_header Cache-Control "public, immutable";
    }

    location = /health {
        proxy_pass http://127.0.0.1:3000/health;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        access_log off;
    }

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_connect_timeout 10s;
        proxy_send_timeout 60s;
        proxy_read_timeout 60s;
    }
}
EOF

ln -sf "$SITE_FILE" /etc/nginx/sites-enabled/volunteer-msuprof
nginx -t
systemctl reload nginx

certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --email "$CERTBOT_EMAIL" --redirect --no-eff-email

echo ""
echo "=== Новый адрес готов, старый сайт не тронут ==="
echo "Проверьте в браузере:"
echo "  https://${DOMAIN}"
echo "  https://${DOMAIN}/register.html"
echo "  https://${DOMAIN}/admin.html"
echo "Пока не проверяли новый адрес — редирект со старого не включайте."
echo "Потом: bash ${APP_DIR}/deploy/enable-legacy-redirect.sh"
