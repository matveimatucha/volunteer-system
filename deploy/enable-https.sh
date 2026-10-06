#!/bin/bash
# HTTPS для одного домена. ПОЛНОСТЬЮ заменяет nginx-сайт `volunteer`.
# Не запускайте, если старый адрес ещё должен работать параллельно.
# Переезд на volunteer.msuprof.com рядом со старым сайтом:
#   bash deploy/enable-new-domain.sh
#
# Использование:
#   DOMAIN=volunteer.msuprof.com bash deploy/enable-https.sh
# www в сертификат не попадает. Нужен www только если явно: INCLUDE_WWW=1
set -euo pipefail

DOMAIN="${DOMAIN:-}"
if [ -z "$DOMAIN" ]; then
  echo "Укажите домен: DOMAIN=volunteer.msuprof.com bash deploy/enable-https.sh"
  echo "Не запускайте этот скрипт для переезда рядом со старым сайтом — используйте enable-new-domain.sh"
  exit 1
fi

if [[ "$DOMAIN" == www.* ]]; then
  echo "Не указывайте www. Для поддомена нужен DOMAIN=volunteer.msuprof.com"
  exit 1
fi

APP_DIR="${APP_DIR:-/var/www/volunteer-system}"
CERTBOT_EMAIL="${CERTBOT_EMAIL:-volunteer@msuprof.com}"

if [ "${INCLUDE_WWW:-}" = "1" ]; then
  SERVER_NAME="${DOMAIN} www.${DOMAIN}"
  CERTBOT_DOMAINS=(-d "$DOMAIN" -d "www.$DOMAIN")
else
  SERVER_NAME="${DOMAIN}"
  CERTBOT_DOMAINS=(-d "$DOMAIN")
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq certbot python3-certbot-nginx

cat > /etc/nginx/sites-available/volunteer <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name ${SERVER_NAME};

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

ln -sf /etc/nginx/sites-available/volunteer /etc/nginx/sites-enabled/volunteer
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl reload nginx

certbot --nginx "${CERTBOT_DOMAINS[@]}" --non-interactive --agree-tos --email "$CERTBOT_EMAIL" --redirect --no-eff-email

echo ""
echo "=== HTTPS готов ==="
echo "https://${DOMAIN}"
echo "https://${DOMAIN}/admin.html"
