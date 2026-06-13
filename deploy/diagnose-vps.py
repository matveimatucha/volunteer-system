#!/usr/bin/env python3
import os
import paramiko
import sys

HOST = os.environ.get('VPS_HOST', '186.246.12.138')
USER = os.environ.get('VPS_USER', 'root')
PASSWORD = os.environ.get('VPS_PASSWORD', '')

cmds = [
    'pm2 list',
    'pm2 logs volunteer --lines 30 --nostream 2>&1 || true',
    'systemctl is-active nginx',
    'ss -tlnp | grep -E ":(80|443|3000)" || true',
    'curl -sI http://127.0.0.1:3000/health | head -8',
    'curl -sI http://127.0.0.1/health | head -8',
    'curl -skI https://127.0.0.1/health | head -8',
    'nginx -t 2>&1',
    'cat /etc/nginx/sites-enabled/volunteer',
    'ufw status 2>&1 || true',
    'tail -50 /var/log/nginx/error.log 2>&1 || true',
    'curl -skI https://186.246.12.138/health -H "Host: volonter-msu.ru" | head -10',
    'echo | openssl s_client -connect 127.0.0.1:443 -servername volonter-msu.ru 2>&1 | head -25',
    'echo | openssl s_client -connect 186.246.12.138:443 -servername volonter-msu.ru 2>&1 | head -25',
    'free -h; df -h /',
]

def main():
    if not PASSWORD:
        print('Set VPS_PASSWORD', file=sys.stderr)
        sys.exit(1)
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(HOST, username=USER, password=PASSWORD, timeout=30,
                   look_for_keys=False, allow_agent=False)
    for cmd in cmds:
        print(f'\n=== {cmd} ===')
        stdin, stdout, stderr = client.exec_command(cmd, timeout=60)
        out = stdout.read().decode('utf-8', 'replace')
        err = stderr.read().decode('utf-8', 'replace')
        if out:
            print(out)
        if err:
            print(err, file=sys.stderr)
        print('exit', stdout.channel.recv_exit_status())
    client.close()

if __name__ == '__main__':
    main()
