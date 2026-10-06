#!/bin/bash
# 301 со старого адреса на новый с сохранением пути и ?event= / ссылок отмены.
# Включать ТОЛЬКО после проверки https://volunteer.msuprof.com
# Когда оплату старого домена выключат, этот редирект сам перестанет работать — это нормально.
set -euo pipefail

NEW_DOMAIN="${NEW_DOMAIN:-volunteer.msuprof.com}"
LEGACY_DOMAIN="${LEGACY_DOMAIN:-volonter-msu.ru}"
APP_DIR="${APP_DIR:-/var/www/volunteer-system}"
NEW_SITE="/etc/nginx/sites-available/volunteer-msuprof"
OLD_SITE="/etc/nginx/sites-available/volunteer"
STAMP="$(date +%Y%m%d%H%M%S)"

if [[ ! -f "$NEW_SITE" ]]; then
  echo "Сначала запустите: bash ${APP_DIR}/deploy/enable-new-domain.sh"
  echo "Новый сайт в nginx ещё не создан — редирект не включаем, чтобы не погасить всё сразу."
  exit 1
fi

if ! curl -fsS --max-time 20 "https://${NEW_DOMAIN}/health" | grep -q '"ok":true'; then
  echo "https://${NEW_DOMAIN}/health ещё не отвечает. Редирект не включаем."
  echo "Сначала откройте новый адрес в браузере и убедитесь, что сайт живой."
  exit 1
fi

mkdir -p /root/nginx-backups
if [[ -f "$OLD_SITE" ]]; then
  cp "$OLD_SITE" "/root/nginx-backups/volunteer.${STAMP}"
fi
if [[ -f /etc/nginx/sites-available/volunteer-default ]]; then
  cp /etc/nginx/sites-available/volunteer-default "/root/nginx-backups/volunteer-default.${STAMP}"
fi

# Старый домен и www старого домена (если был) ведут на новый адрес с тем же путём.
cat > "$OLD_SITE" <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name ${LEGACY_DOMAIN} www.${LEGACY_DOMAIN};
    return 301 https://${NEW_DOMAIN}\$request_uri;
}

server {
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name ${LEGACY_DOMAIN} www.${LEGACY_DOMAIN};
    ssl_certificate /etc/letsencrypt/live/${LEGACY_DOMAIN}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/${LEGACY_DOMAIN}/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;
    return 301 https://${NEW_DOMAIN}\$request_uri;
}
EOF

if [[ -f /etc/nginx/sites-available/volunteer-default ]]; then
  cat > /etc/nginx/sites-available/volunteer-default <<EOF
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name _;
    return 301 https://${NEW_DOMAIN}\$request_uri;
}

server {
    listen 443 ssl default_server;
    listen [::]:443 ssl default_server;
    server_name _;
    ssl_certificate /etc/letsencrypt/live/${NEW_DOMAIN}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/${NEW_DOMAIN}/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;
    return 301 https://${NEW_DOMAIN}\$request_uri;
}
EOF
fi

ln -sf "$OLD_SITE" /etc/nginx/sites-enabled/volunteer
nginx -t
systemctl reload nginx

echo ""
echo "=== Редирект включён ==="
echo "Старые ссылки вида https://${LEGACY_DOMAIN}/register.html?event=... "
echo "должны открывать https://${NEW_DOMAIN}/register.html?event=..."
echo "Когда старый домен перестанет быть оплачен, редирект умрёт сам. Продлевать не надо."
