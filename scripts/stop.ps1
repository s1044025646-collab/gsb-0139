# Stop exactly the server process recorded by start.ps1 (this project only).
$ErrorActionPreference = "Stop"
$root = Resolve-Path (Join-Path $PSScriptRoot "..")
$pidFile = Join-Path $root "data/server.pid"
if (-not (Test-Path $pidFile)) {
  Write-Host "no pid file at data/server.pid; nothing to stop"
  exit 0
}
$id = [int](Get-Content $pidFile -Raw)
$proc = Get-Process -Id $id -ErrorAction SilentlyContinue
if ($proc) {
  Stop-Process -Id $id
  Write-Host "stopped pid=$id"
} else {
  Write-Host "pid=$id not running"
}
Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
Remove-Item (Join-Path $root "data/server.url") -Force -ErrorAction SilentlyContinue
