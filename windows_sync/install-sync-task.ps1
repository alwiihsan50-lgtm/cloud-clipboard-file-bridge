param(
    [string]$LocalPath = 'D:\Cloud Bridge',
    [string]$SourceScript = (Join-Path $PSScriptRoot 'sync-cloudbridge.ps1')
)

$ErrorActionPreference = 'Stop'
$stateDir = Join-Path $env:LOCALAPPDATA 'CloudBridge\Sync'
$installedScript = Join-Path $stateDir 'sync-cloudbridge.ps1'
New-Item -ItemType Directory -Path $stateDir -Force | Out-Null
Copy-Item -LiteralPath $SourceScript -Destination $installedScript -Force

$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument (
    "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$installedScript`" -LocalPath `"$LocalPath`""
)
$trigger = New-ScheduledTaskTrigger `
    -Once `
    -At (Get-Date).AddMinutes(1) `
    -RepetitionInterval (New-TimeSpan -Minutes 1) `
    -RepetitionDuration (New-TimeSpan -Days 3650)
$settings = New-ScheduledTaskSettingsSet `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 10) `
    -MultipleInstances IgnoreNew `
    -StartWhenAvailable
$currentUser = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$principal = New-ScheduledTaskPrincipal -UserId $currentUser -LogonType Interactive -RunLevel Limited

Register-ScheduledTask `
    -TaskName 'CloudBridge Folder Sync' `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Principal $principal `
    -Description 'Two-way sync between D:\Cloud Bridge and CloudBridge WebDAV.' `
    -Force | Out-Null

Write-Output "CloudBridge Folder Sync task installed."
