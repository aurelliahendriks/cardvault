#Requires -Version 5.1
<#
  CardVault setup, Windows.

  Two routes. Docker is the one to take unless you have a reason not to: the containers
  bring their own Node, Postgres 16 with pgvector, and Redis, so nothing has to be
  installed or version-matched by hand.

      .\setup.ps1              Docker route: build, migrate, seed, start
      .\setup.ps1 -Local       local route: your own Node 22 + a Postgres you supply
      .\setup.ps1 -Reset       destroy the database volume and start clean

  Idempotent: safe to run again after a failure.

  This file is deliberately plain ASCII. A single em dash in a BOM-less .ps1 breaks
  Windows PowerShell 5.1, which reads the file as Windows-1252 and turns the dash's last
  byte into a smart quote - closing the string early. Keep it ASCII.
#>
param(
  [switch]$Local,
  [switch]$Reset
)

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

function Say  ($m) { Write-Host "  $m" }
function Ok   ($m) { Write-Host "  [ok] $m" -ForegroundColor Green }
function Warn ($m) { Write-Host "  [!]  $m" -ForegroundColor Yellow }
function Die  ($m) { Write-Host "  [x]  $m" -ForegroundColor Red; exit 1 }

function Invoke-Native {
  # Run a native command with stderr treated as output rather than as a terminating
  # error, and hand back the exit code. Every docker/npm call goes through this.
  param([string]$exe, [string[]]$exeArgs, [switch]$Quiet)
  $old = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    if ($Quiet) { & $exe @exeArgs 2>&1 | Out-Null } else { & $exe @exeArgs 2>&1 | Out-Host }
    return $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $old
  }
}

function Test-Docker {
  return (Invoke-Native 'docker' @('info') -Quiet) -eq 0
}

function Start-DockerDesktop {
  # Docker Desktop being installed but not started is the single most common way this
  # script fails, and it is fixable without the user leaving the terminal.
  $candidates = @(
    (Join-Path $env:ProgramFiles 'Docker\Docker\Docker Desktop.exe'),
    (Join-Path ${env:ProgramFiles(x86)} 'Docker\Docker\Docker Desktop.exe'),
    (Join-Path $env:LOCALAPPDATA 'Docker\Docker Desktop.exe')
  ) | Where-Object { $_ -and (Test-Path $_) }

  if (-not $candidates) { return $false }
  Say "starting Docker Desktop..."
  Start-Process -FilePath $candidates[0] | Out-Null

  foreach ($i in 1..60) {
    Start-Sleep -Seconds 3
    if (Test-Docker) { return $true }
    if ($i % 10 -eq 0) { Say "still waiting for the Docker engine ($($i * 3)s)..." }
  }
  return $false
}

function Get-EnvValue($key, $fallback) {
  # Deliberately not Select-String piped into .Matches.Groups: that throws on no match,
  # and with $ErrorActionPreference = Stop it would abort the whole script.
  if (-not (Test-Path .env)) { return $fallback }
  foreach ($line in Get-Content .env) {
    if ($line -match "^\s*$key\s*=\s*(.*)$") {
      $v = $Matches[1].Trim()
      if ($v) { return $v }
    }
  }
  return $fallback
}

Write-Host ""
Write-Host "CardVault setup" -ForegroundColor Cyan
Write-Host ("-" * 52)

# --- .env ---------------------------------------------------------------------
if (-not (Test-Path .env)) {
  Copy-Item .env.example .env
  # A default password in a file called .env has a way of reaching production.
  $bytes = New-Object 'System.Byte[]' 24
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  $pw = ([Convert]::ToBase64String($bytes) -replace '[^A-Za-z0-9]', '')
  if ($pw.Length -gt 20) { $pw = $pw.Substring(0, 20) }
  (Get-Content .env) -replace '^POSTGRES_PASSWORD=.*', "POSTGRES_PASSWORD=$pw" | Set-Content .env
  Ok "created .env with a generated database password"
} else {
  Say ".env already present, leaving it alone"
}

if ($Local) {
  # --- local route ------------------------------------------------------------
  Write-Host ""
  Say "Local route: needs Node 22+, a Postgres 16 with pgvector, pg_trgm and unaccent,"
  Say "and Redis for the job queue."

  if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Die "Node not found. Install Node 22 LTS from https://nodejs.org and re-run."
  }
  $major = [int](((node -v) -replace '^v', '') -split '\.')[0]
  if ($major -lt 20) { Die "Node $major is too old; this needs 20 or newer (22 recommended)." }
  Ok "node $(node -v)"

  if (-not (Test-Path node_modules)) {
    Say "installing dependencies..."
    if ((Invoke-Native 'npm' @('install', '--no-audit', '--no-fund')) -ne 0) { Die "npm install failed" }
  }
  Ok "dependencies installed"

  if (-not $env:DATABASE_URL) {
    Warn "DATABASE_URL is not set. Point it at your Postgres first, for example:"
    Say  '$env:DATABASE_URL = "postgres://cardvault:PASSWORD@127.0.0.1:5432/cardvault"'
    Say  '$env:REDIS_URL    = "redis://127.0.0.1:6379"'
    Die  "no database to migrate against"
  }

  Say "running migrations..."
  if ((Invoke-Native 'npm' @('run', 'migrate')) -ne 0) { Die "migrations failed" }
  Say "seeding the checklist (1,771 cards, 783 players)..."
  if ((Invoke-Native 'npm' @('run', 'seed')) -ne 0) { Die "seed failed" }
  Ok "database ready"

  Write-Host ""
  Say "Start it with two terminals:"
  Say "  npm run dev:api      -> http://localhost:8080"
  Say "  npm run dev:worker   (queue, cron, ingest)"
  exit 0
}

# --- docker route -------------------------------------------------------------
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
  Die "Docker not found. Install Docker Desktop, start it, then re-run. Or: .\setup.ps1 -Local"
}
if (-not (Test-Docker)) {
  Warn "the Docker engine is not responding, so Docker Desktop is installed but not running."
  if (-not (Start-DockerDesktop)) {
    Write-Host ""
    Die @"
Could not reach the Docker engine.

  Start Docker Desktop from the Start menu, wait for the whale icon in the tray to stop
  animating, then run .\setup.ps1 again.

  If Docker Desktop is not installed:
    https://docs.docker.com/desktop/install/windows-install/

  If you would rather not use Docker at all, you need Postgres 16 with the pgvector
  extension plus Redis, then: .\setup.ps1 -Local
"@
  }
  Ok "Docker engine is up"
}
$dv = ''
try { $dv = (& docker version --format '{{.Server.Version}}' 2>$null) } catch { }
if (-not $dv) { $dv = 'version unknown' }
Ok "docker $dv"

if ($Reset) {
  Warn "Reset deletes the database volume and everything recorded in it."
  if ((Read-Host "  type RESET to confirm") -ne 'RESET') { Die "aborted" }
  Invoke-Native 'docker' @('compose', 'down', '-v') | Out-Null
  Ok "volumes removed"
}

Say "building and starting (first run pulls images and compiles; give it a few minutes)..."
$code = Invoke-Native 'docker' @('compose', 'up', '-d', '--build')
if ($code -ne 0) { Die "compose failed - scroll up for the reason" }

# The api container waits for migrate to finish, so health is the real ready signal.
$port = Get-EnvValue 'API_PORT' '8080'
Say "waiting for the API on port $port..."
$ready = $false
foreach ($i in 1..90) {
  try {
    if ((Invoke-WebRequest -Uri "http://localhost:$port/api/health" -TimeoutSec 3 -UseBasicParsing).StatusCode -eq 200) {
      $ready = $true
      break
    }
  } catch {
    Start-Sleep -Seconds 2
  }
}
if (-not $ready) {
  Warn "the API did not answer in about three minutes. Recent logs:"
  Invoke-Native 'docker' @('compose', 'logs', '--tail', '40', 'migrate', 'api') | Out-Null
  Die "not healthy yet - the migrate step is the usual culprit"
}

$health = (Invoke-WebRequest -Uri "http://localhost:$port/api/health" -UseBasicParsing).Content | ConvertFrom-Json
Ok "API healthy: $($health.cards) cards seeded, $($health.soldComps) sold comps"

Write-Host ""
Write-Host "  Open  http://localhost:$port" -ForegroundColor Cyan
Write-Host ""
Say "Next, in rough order of how much they are worth:"
Say "  1. Add what you own          the + on any tile, or the Add card button"
Say "  2. Fetch player photographs  docker compose exec api node dist/cli/portraits.js"
Say "  3. eBay keys into .env       then: docker compose restart api worker"
Say "  4. Import old comps          Data and sources tab, paste CSV"
Write-Host ""
Say "  docker compose logs -f api      follow the API"
Say "  docker compose down             stop everything (data survives)"
Say "  .\setup.ps1 -Reset              start the database over"
