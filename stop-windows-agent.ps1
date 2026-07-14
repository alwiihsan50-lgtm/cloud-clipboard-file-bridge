$ProjectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$AgentDir = Join-Path $ProjectRoot "windows_agent"
$PythonPath = Join-Path $AgentDir ".venv\Scripts\python.exe"

Get-CimInstance Win32_Process |
  Where-Object {
    $_.ProcessId -ne $PID -and
    $_.Name -in @("python.exe", "pythonw.exe") -and
    $_.CommandLine -like "*$PythonPath*" -and
    $_.CommandLine -like "*tray_agent.py*"
  } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

Get-CimInstance Win32_Process |
  Where-Object {
    $_.ProcessId -ne $PID -and
    $_.Name -eq "powershell.exe" -and
    $_.CommandLine -like "*$AgentDir*" -and
    $_.CommandLine -like "*tray_agent.py*"
  } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

Write-Output "CloudBridge Windows Agent stopped."
