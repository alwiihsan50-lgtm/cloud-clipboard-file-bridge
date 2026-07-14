$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$AgentScript = Join-Path $ProjectRoot "start-windows-agent.ps1"

& $AgentScript

Write-Output "CloudBridge uses the stable Supabase URL:"
Write-Output "https://ajlkfzgpheegmwsnspxw.supabase.co/functions/v1/cloudbridge"
