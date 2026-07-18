param(
    [string]$LocalPath = 'D:\Cloud Bridge'
)

$ErrorActionPreference = 'Stop'
$stateDir = Join-Path $env:LOCALAPPDATA 'CloudBridge\Sync'
$configPath = Join-Path $stateDir 'rclone.conf'
$logPath = Join-Path $stateDir 'sync.log'
$rclone = (Get-Command rclone.exe -ErrorAction SilentlyContinue).Source

if (-not $rclone) {
    $wingetPath = Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Links\rclone.exe'
    if (Test-Path -LiteralPath $wingetPath) { $rclone = $wingetPath }
}
if (-not $rclone) {
    $rclone = Get-ChildItem `
        -Path (Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Packages') `
        -Filter 'rclone.exe' `
        -File `
        -Recurse `
        -ErrorAction SilentlyContinue |
        Select-Object -First 1 -ExpandProperty FullName
}
if (-not $rclone -or -not (Test-Path -LiteralPath $configPath)) { exit 0 }

New-Item -ItemType Directory -Path $LocalPath -Force | Out-Null
New-Item -ItemType Directory -Path $stateDir -Force | Out-Null

$mutex = [Threading.Mutex]::new($false, 'Local\CloudBridgeWebdavSync')
if (-not $mutex.WaitOne(0)) { exit 0 }

try {
    & $rclone bisync $LocalPath 'cloudbridge-webdav:/' `
        --config $configPath `
        --workdir $stateDir `
        --resilient `
        --recover `
        --compare size,checksum `
        --conflict-resolve larger `
        --conflict-loser num `
        --create-empty-src-dirs `
        --max-lock 2m `
        --log-file $logPath `
        --log-level INFO

    if ($LASTEXITCODE -ne 0) {
        throw "rclone bisync exited with code $LASTEXITCODE"
    }
}
catch {
    Add-Content -LiteralPath $logPath -Value "$(Get-Date -Format o) ERROR $($_.Exception.Message)"
    exit 1
}
finally {
    $mutex.ReleaseMutex()
    $mutex.Dispose()
}
