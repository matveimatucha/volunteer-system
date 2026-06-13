# Загрузка service-account.json на VPS через SCP (Windows).
# Использование:
#   .\deploy\upload-secrets.ps1 -ServerIp 186.246.12.138
param(
    [Parameter(Mandatory = $true)]
    [string]$ServerIp,
    [string]$User = 'root',
    [string]$KeyFile = ''
)

$Root = Split-Path $PSScriptRoot -Parent
$LocalJson = Join-Path $Root 'server\service-account.json'
$RemotePath = '/var/www/volunteer-system/server/service-account.json'

if (-not (Test-Path $LocalJson)) {
    Write-Error "Не найден $LocalJson — положите ключ Firebase в server\service-account.json"
    exit 1
}

Write-Host "Загрузка ключа на ${User}@${ServerIp}:$RemotePath"
if ($KeyFile) {
    scp -i $KeyFile $LocalJson "${User}@${ServerIp}:$RemotePath"
} else {
    scp $LocalJson "${User}@${ServerIp}:$RemotePath"
}

if ($LASTEXITCODE -ne 0) {
    Write-Error 'SCP не удался. Проверьте пароль root и что vps-setup.sh уже выполнен.'
    exit 1
}

Write-Host 'Готово. На сервере выполните:'
Write-Host "  ssh ${User}@${ServerIp}"
Write-Host '  chmod 600 /var/www/volunteer-system/server/service-account.json'
Write-Host '  cd /var/www/volunteer-system/server && pm2 restart volunteer'
Write-Host '  npm run set-admin -- matvei.sukmanov@chemistry.msu.ru'
