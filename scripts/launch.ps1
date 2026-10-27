# One-click start: server + backdrop on the LED/projector screen + operator panel on the laptop screen.
param([switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

# Read PORT and CONTROL_KEY from .env (defaults match server.js)
$port = 3000; $key = 'jito'
if (Test-Path "$root\.env") {
  foreach ($line in Get-Content "$root\.env") {
    if ($line -match '^\s*PORT\s*=\s*(\d+)') { $port = [int]$Matches[1] }
    if ($line -match '^\s*CONTROL_KEY\s*=\s*(.+?)\s*$') { $key = $Matches[1] }
  }
}
$base = "http://localhost:$port"
$probe = "http://127.0.0.1:$port/health"

if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Write-Host 'Node.js is not installed. Get it from https://nodejs.org (LTS).' -ForegroundColor Red; Read-Host 'Press Enter to exit'; exit 1 }
if (-not (Test-Path "$root\node_modules")) { Write-Host 'Installing dependencies (first run only)...'; npm install --no-fund --no-audit | Out-Host }

# Start the server unless one is already answering.
$running = $false
try { Invoke-RestMethod $probe -TimeoutSec 2 | Out-Null; $running = $true } catch {}
if (-not $running) {
  Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', "`"$root\scripts\run-server.cmd`"" -WorkingDirectory $root -WindowStyle Minimized
  for ($i = 0; $i -lt 40; $i++) { Start-Sleep -Milliseconds 250; try { Invoke-RestMethod $probe -TimeoutSec 1 | Out-Null; $running = $true; break } catch {} }
}
if (-not $running) { Write-Host 'Server did not start. Open the "Live Backdrop server" window to see why.' -ForegroundColor Red; Read-Host 'Press Enter to exit'; exit 1 }
if ($NoBrowser) { exit 0 }

# Find Chrome, else Edge.
$browser = @(
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
  "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
  "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $browser) { Start-Process "$base/control?key=$key"; Start-Process "$base/display"; exit 0 }

Add-Type -AssemblyName System.Windows.Forms
$screens = [System.Windows.Forms.Screen]::AllScreens
$primary = $screens | Where-Object Primary | Select-Object -First 1
$led = $screens | Where-Object { -not $_.Primary } | Select-Object -First 1
$profiles = "$env:LOCALAPPDATA\LiveBackdrop"

# Separate browser profiles keep the two windows independent (and remember the mic permission).
$common = @('--no-first-run', '--no-default-browser-check', '--disable-session-crashed-bubble', '--disable-features=Translate', '--autoplay-policy=no-user-gesture-required')
if ($led) {
  $b = $led.Bounds
  Start-Process $browser -ArgumentList ($common + @("--user-data-dir=`"$profiles\display`"", "--app=$base/display", "--window-position=$($b.X),$($b.Y)", "--window-size=$($b.Width),$($b.Height)", '--start-fullscreen'))
  Write-Host "Backdrop opened fullscreen on the second screen ($($b.Width)x$($b.Height))."
} else {
  Start-Process $browser -ArgumentList ($common + @("--user-data-dir=`"$profiles\display`"", "--app=$base/display", '--window-size=1280,720'))
  Write-Host 'Only one screen found. Backdrop opened in a window: press F for fullscreen, Ctrl+Shift+S for hidden settings.'
}
$p = $primary.WorkingArea
Start-Process $browser -ArgumentList ($common + @("--user-data-dir=`"$profiles\control`"", "--app=$base/control?key=$key", "--window-position=$($p.X),$($p.Y)", "--window-size=$([Math]::Min($p.Width,1400)),$($p.Height)"))
Write-Host "Operator panel opened. Server: $base"
