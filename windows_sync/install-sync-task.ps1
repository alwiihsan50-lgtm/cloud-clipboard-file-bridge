param(
    [string]$LocalPath = 'D:\Cloud Bridge',
    [string]$SourceScript = (Join-Path $PSScriptRoot 'sync-cloudbridge.ps1'),
    [string]$HiddenLauncher = (Join-Path $PSScriptRoot 'run-sync-hidden.vbs')
)

$ErrorActionPreference = 'Stop'
$stateDir = Join-Path $env:LOCALAPPDATA 'CloudBridge\Sync'
$installedScript = Join-Path $stateDir 'sync-cloudbridge.ps1'
$installedLauncher = Join-Path $stateDir 'run-sync-hidden.vbs'
New-Item -ItemType Directory -Path $stateDir -Force | Out-Null
Copy-Item -LiteralPath $SourceScript -Destination $installedScript -Force
Copy-Item -LiteralPath $HiddenLauncher -Destination $installedLauncher -Force

$action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument (
    "`"$installedLauncher`" `"$LocalPath`""
)
$trigger = New-ScheduledTaskTrigger `
    -Once `
    -At (Get-Date).AddMinutes(15) `
    -RepetitionInterval (New-TimeSpan -Minutes 15) `
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
    -Description '15-minute fallback for event-driven CloudBridge folder sync.' `
    -Force | Out-Null

Write-Output "CloudBridge Folder Sync task installed."
