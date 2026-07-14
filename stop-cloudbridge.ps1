$ProjectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path

& (Join-Path $ProjectRoot "stop-windows-agent.ps1")

Get-CimInstance Win32_Process |
  Where-Object {
    $_.ProcessId -ne $PID -and
    $_.CommandLine -like "*$ProjectRoot*" -and
    ($_.CommandLine -like "*uvicorn*" -or $_.CommandLine -like "*cloudflared tunnel*")
  } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

Write-Output "CloudBridge stopped."
