param(
    [string]$ProjectRef = 'ajlkfzgpheegmwsnspxw',
    [string]$LocalPath = 'D:\Cloud Bridge'
)

$ErrorActionPreference = 'Stop'
$rclone = Get-ChildItem `
    -Path (Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Packages') `
    -Filter 'rclone.exe' `
    -File `
    -Recurse `
    -ErrorAction SilentlyContinue |
    Select-Object -First 1 -ExpandProperty FullName
if (-not $rclone) { throw 'rclone.exe was not found.' }

$stateDir = Join-Path $env:LOCALAPPDATA 'CloudBridge\Sync'
$configPath = Join-Path $stateDir 'rclone.conf'
$setupPath = Join-Path $stateDir 'iPhone-setup.txt'
New-Item -ItemType Directory -Path $stateDir -Force | Out-Null

$bytes = New-Object byte[] 32
[Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
$token = [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
$envFile = Join-Path $env:TEMP ("cloudbridge-secrets-$([guid]::NewGuid().ToString('N')).env")

try {
    @(
        "CLOUD_BRIDGE_WEBDAV_TOKEN=$token"
        'CLOUD_BRIDGE_WEBDAV_USER=cloudbridge'
        'CLOUD_BRIDGE_SYNC_BUCKET=cloudbridge-sync'
    ) | Set-Content -LiteralPath $envFile -Encoding ASCII

    npx supabase secrets set --env-file $envFile --project-ref $ProjectRef | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Failed to set Edge Function secrets.' }
}
finally {
    Remove-Item -LiteralPath $envFile -Force -ErrorAction SilentlyContinue
}

& $rclone config create cloudbridge-webdav webdav `
    url "https://$ProjectRef.supabase.co/functions/v1/cloudbridge/webdav/" `
    vendor other `
    user cloudbridge `
    pass $token `
    --obscure `
    --config $configPath | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Failed to create the rclone config.' }

@(
    'CloudBridge Files setup'
    ''
    "Server: https://$ProjectRef.supabase.co/functions/v1/cloudbridge/webdav/"
    'Username: cloudbridge'
    "Password: $token"
    ''
    'Tambahkan sebagai koneksi WebDAV di Owlfiles.'
    'Lalu aktifkan Owlfiles dari Files > Browse > ... > Edit.'
) | Set-Content -LiteralPath $setupPath -Encoding UTF8

icacls $stateDir /inheritance:r /grant:r "${env:USERDOMAIN}\${env:USERNAME}:(OI)(CI)F" | Out-Null

New-Item -ItemType Directory -Path $LocalPath -Force | Out-Null
& $rclone copy $LocalPath 'cloudbridge-webdav:/' `
    --config $configPath `
    --create-empty-src-dirs
if ($LASTEXITCODE -ne 0) { throw 'Initial upload failed.' }

& $rclone bisync $LocalPath 'cloudbridge-webdav:/' `
    --config $configPath `
    --workdir $stateDir `
    --resync `
    --compare size,checksum `
    --create-empty-src-dirs
if ($LASTEXITCODE -ne 0) { throw 'Initial bisync state failed.' }

& (Join-Path $PSScriptRoot 'install-sync-task.ps1') -LocalPath $LocalPath

[pscustomobject]@{
    Config = $configPath
    PhoneSetup = $setupPath
    Task = 'CloudBridge Folder Sync'
} | ConvertTo-Json

$token = $null
