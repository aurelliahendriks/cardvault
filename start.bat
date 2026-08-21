@echo off
REM CardVault :: double-click this.
REM
REM The Windows twin of start.command. Same job: check Docker, start everything, wait until
REM the app actually answers, open the browser.
REM
REM Written in .bat rather than PowerShell on purpose - a .bat runs on a double-click, while a
REM .ps1 opens in Notepad unless the execution policy has been changed, which is a confusing
REM first experience for something whose whole job is to be the easy way in.

setlocal enabledelayedexpansion
cd /d "%~dp0"

echo.
echo   CardVault
echo   %CD%
echo.

REM --- 1. Docker installed? -------------------------------------------------
where docker >nul 2>&1
if errorlevel 1 (
  echo   Docker isn't installed.
  echo.
  echo   CardVault needs it - it's what runs the database that holds your cards.
  echo   Download Docker Desktop ^(free^) from:
  echo.
  echo       https://www.docker.com/products/docker-desktop/
  echo.
  echo   Install it, open it once, then double-click this file again.
  echo.
  pause
  exit /b 1
)

REM --- 2. Docker RUNNING? ---------------------------------------------------
REM Installed and running are different things. The error when it is installed but not running
REM - "error during connect ... The system cannot find the file specified" - reads like a
REM broken installation rather than "the app isn't open yet".
docker info >nul 2>&1
if errorlevel 1 (
  echo   Docker is installed but not running.
  echo   Starting Docker Desktop - this takes 20-40 seconds the first time.
  start "" "%ProgramFiles%\Docker\Docker\Docker Desktop.exe" >nul 2>&1
  <nul set /p "=  waiting"
  for /l %%i in (1,1,40) do (
    docker info >nul 2>&1
    if not errorlevel 1 goto dockerup
    <nul set /p "=."
    timeout /t 2 /nobreak >nul
  )
  echo.
  echo   Docker still isn't answering.
  echo   Open Docker Desktop from the Start menu, wait for the whale in the system tray to
  echo   stop animating, then run this again.
  echo.
  pause
  exit /b 1
)
:dockerup
echo.

REM --- 3. settings ----------------------------------------------------------
REM Never overwritten: replacing .env would reset the database password on a database that
REM still has the old one, and the app would then fail to connect for no visible reason.
if not exist ".env" (
  copy ".env.example" ".env" >nul
  echo   created .env from .env.example
)

REM --- 4. up ----------------------------------------------------------------
echo   Starting CardVault...
echo   first run downloads Postgres and Redis - a few minutes. After that it's seconds.
echo.
docker compose up -d
if errorlevel 1 (
  echo.
  echo   Something went wrong starting the containers.
  echo   The output above says what. Copy it into the chat and I'll read it.
  echo.
  pause
  exit /b 1
)

REM --- 5. wait for it to actually answer -----------------------------------
REM `up -d` succeeding means the CONTAINERS started, not that the app is ready: Postgres has to
REM come up, the migration has to run, and the seed has to load 2,521 cards. Opening the
REM browser on `up -d` alone shows a connection error and looks like a failure.
<nul set /p "=  Waiting for it to be ready"
set READY=
for /l %%i in (1,1,90) do (
  curl -sf http://localhost:8080/api/health >nul 2>&1
  if not errorlevel 1 (
    set READY=1
    goto ready
  )
  <nul set /p "=."
  timeout /t 2 /nobreak >nul
)
:ready
echo.

if not defined READY (
  echo.
  echo   It's taking longer than expected.
  echo   The first start loads 2,521 cards, which can take a few minutes.
  echo   Watch what it's doing with:
  echo.
  echo       docker compose logs -f api
  echo.
  pause
  exit /b 1
)

echo.
echo   CardVault is running.
echo.
echo       http://localhost:8080
echo.
echo   Opening it now. BOOKMARK IT - don't open index.html from the folder,
echo   that's only the screen and it can't work on its own.
echo.
echo   To stop it later:  docker compose down    ^(your cards are kept^)
echo.
start "" http://localhost:8080
timeout /t 3 /nobreak >nul
