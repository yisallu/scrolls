$ErrorActionPreference = "Stop"

$procs = Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match "w2x-worker\.mjs" }
if (-not $procs) {
  Write-Host "No waifu2x worker process found."
  return
}

foreach ($p in $procs) {
  Write-Host "Stopping waifu2x worker (PID $($p.ProcessId))..."
  Stop-Process -Id $p.ProcessId -Force
}
Write-Host "waifu2x worker stopped."
