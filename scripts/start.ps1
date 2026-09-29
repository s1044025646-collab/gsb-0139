# Start the backend bound ONLY to 127.0.0.1 on an OS-assigned free port.
# Writes the process id + url to data/server.pid / data/server.url.
# Manages only THIS project's server process.
$ErrorActionPreference = "Stop"
$root = Resolve-Path (Join-Path $PSScriptRoot "..")
New-Item -ItemType Directory -Force (Join-Path $root "data") | Out-Null
$db = Join-Path $root "data/app.sqlite"
$pidFile = Join-Path $root "data/server.pid"
$urlFile = Join-Path $root "data/server.url"

$p = Start-Process -FilePath "node" `
  -ArgumentList "--experimental-sqlite","--no-warnings",(Join-Path $root "src/server.ts") `
  -WorkingDirectory $root -WindowStyle Hidden -PassThru `
  -RedirectStandardOutput (Join-Path $root "data/server.out.log") `
  -RedirectStandardError (Join-Path $root "data/server.err.log")

Set-Content -Path $pidFile -Value $p.Id -NoNewline

$url = $null
for ($i = 0; $i -lt 50; $i++) {
  Start-Sleep -Milliseconds 100
  $line = Select-String -Path (Join-Path $root "data/server.out.log") -Pattern "listening on (http://127\.0\.0\.1:\d+)" -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($line) {
    $url = $line.Matches[0].Groups[1].Value
    break
  }
  if ($p.HasExited) {
    throw "server exited early; see data/server.err.log"
  }
}
if (-not $url) { throw "server did not report a listening URL in time" }
Set-Content -Path $urlFile -Value $url -NoNewline
Write-Host "started pid=$($p.Id) at $url (db $db)"
