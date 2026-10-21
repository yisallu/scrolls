$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = Split-Path -Parent $root
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) {
  throw "node was not found in PATH."
}

# Read token from env or data/w2x-token
$token = $env:W2X_TOKEN
if (-not $token) {
  $tokenFile = Join-Path $projectRoot "data\w2x-token"
  if (Test-Path $tokenFile) {
    $token = (Get-Content $tokenFile -Raw).Trim()
  }
}
if (-not $token) {
  throw "W2X_TOKEN not found in environment or data/w2x-token."
}

# Check if already running
$existing = Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match "w2x-worker\.mjs" }
if ($existing) {
  Write-Host "waifu2x worker is already running (PID: $($existing.ProcessId -join ', '))."
} else {
  $workerScript = Join-Path $root "w2x-worker.mjs"
  Start-Process -FilePath $node -ArgumentList @($workerScript) -WorkingDirectory $projectRoot -WindowStyle Hidden
  Start-Sleep -Seconds 1
}

$server = if ($env:W2X_SERVER) { $env:W2X_SERVER.TrimEnd('/') } else { "https://web.sysmeng.com" }
try {
  $status = Invoke-RestMethod -Uri "$server/api/w2x/status?token=$token" -TimeoutSec 5
  if ($status.online) {
    Write-Host "waifu2x worker started successfully! Online: $($status.online), IdleWorkers: $($status.idleWorkers)"
  } else {
    Write-Warning "Worker started, but server reports online=$($status.online). Waiting another 2s..."
    Start-Sleep -Seconds 2
    $status = Invoke-RestMethod -Uri "$server/api/w2x/status?token=$token" -TimeoutSec 5
    Write-Host "Current status: online=$($status.online), idleWorkers=$($status.idleWorkers)"
  }
} catch {
  Write-Warning "Could not query status from $($server): $($_.Exception.Message)"
}
