#!/bin/bash
# HTTPS и домен для volunteer-system на VPS.
# Использование: DOMAIN=example.ru bash deploy/enable-https.sh
set -euo pipefail

DOMAIN="${DOMAIN:-}"
if [ -z "$DOMAIN" ]; then
  echo "Укажите домен: DOMAIN=ваш-домен.ru bash deploy/enable-https.sh"
  exit 1
fi

APP_DIR="${APP_DIR:-/var/www/volunteer-system}"

export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq certbot python3-certbot-nginx

cat > /etc/nginx/sites-available/volunteer <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name ${DOMAIN} www.${DOMAIN};

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

certbot --nginx -d "$DOMAIN" -d "www.$DOMAIN" --non-interactive --agree-tos --register-unsafely-without-email --redirect

echo ""
echo "=== HTTPS готов ==="
echo "https://${DOMAIN}"
echo "https://${DOMAIN}/admin.html"
