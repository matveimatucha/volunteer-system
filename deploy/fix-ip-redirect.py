#!/usr/bin/env python3
"""Add default nginx server so IP access redirects to the domain."""
import os
import sys
import paramiko

HOST = os.environ.get('VPS_HOST', '186.246.12.138')
USER = os.environ.get('VPS_USER', 'root')
PASSWORD = os.environ.get('VPS_PASSWORD', '')
DOMAIN = os.environ.get('DOMAIN', 'volonter-msu.ru')


def run(client, cmd, timeout=120):
    print(f'\n>>> {cmd}')
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

    script = f'''#!/bin/bash
set -euo pipefail
DOMAIN="{DOMAIN}"
cat > /etc/nginx/sites-available/volunteer-default <<'NGX'
server {{
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name _;
    return 301 https://{DOMAIN}$request_uri;
}}

server {{
    listen 443 ssl default_server;
    listen [::]:443 ssl default_server;
    server_name _;
    ssl_certificate /etc/letsencrypt/live/{DOMAIN}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/{DOMAIN}/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;
    return 301 https://{DOMAIN}$request_uri;
}}
NGX
ln -sf /etc/nginx/sites-available/volunteer-default /etc/nginx/sites-enabled/volunteer-default
nginx -t
systemctl reload nginx
echo DEFAULT_REDIRECT_OK
'''

    sftp = client.open_sftp()
    with sftp.file('/tmp/fix-default-nginx.sh', 'w') as f:
        f.write(script)
    sftp.chmod('/tmp/fix-default-nginx.sh', 0o755)
    sftp.close()

    code, out = run(client, 'bash /tmp/fix-default-nginx.sh')
    run(client, f'curl -sI http://127.0.0.1/ -H "Host: 186.246.12.138" | head -5 || true')
    run(client, f'curl -skI https://127.0.0.1/ | head -5 || true')
    client.close()
    sys.exit(0 if code == 0 and 'DEFAULT_REDIRECT_OK' in out else code)


if __name__ == '__main__':
    main()
