#!/bin/bash
# CardVault :: double-click this.
#
# A .command file is a shell script macOS runs when you double-click it in Finder — the Mac
# equivalent of a .bat. It exists because "open Terminal, cd to the folder, type a docker
# command" is three chances to get lost before anything happens, and none of those steps are
# the interesting part.
#
# If Finder opens this in a text editor instead of running it, the executable bit was lost
# (some unzip tools drop it). Fix with one line in Terminal, in this folder:
#
#     chmod +x start.command

cd "$(dirname "$0")" || exit 1

BOLD=$'\033[1m'; DIM=$'\033[2m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; RED=$'\033[31m'; OFF=$'\033[0m'

echo ""
echo "${BOLD}CardVault${OFF}"
echo "${DIM}$(pwd)${OFF}"
echo ""

# --- 1. Docker installed? -------------------------------------------------
if ! command -v docker >/dev/null 2>&1; then
  echo "${RED}Docker isn't installed.${OFF}"
  echo ""
  echo "  CardVault needs it — it's what runs the database that holds your cards."
  echo "  Download Docker Desktop (free) from:"
  echo ""
  echo "      ${BOLD}https://www.docker.com/products/docker-desktop/${OFF}"
  echo ""
  echo "  Pick the Apple Silicon or Intel build to match your Mac, install it, open it once,"
  echo "  then double-click this file again."
  echo ""
  read -r -p "Press Enter to close."
  exit 1
fi

# --- 2. Docker RUNNING? ---------------------------------------------------
# Installed and running are different things, and the error when it is installed but not
# running ("Cannot connect to the Docker daemon") reads like a broken installation.
if ! docker info >/dev/null 2>&1; then
  echo "${YELLOW}Docker is installed but not running.${OFF}"
  echo ""
  echo "  Starting Docker Desktop for you — this takes 20-40 seconds the first time."
  open -a Docker 2>/dev/null
  printf "  waiting"
  for _ in $(seq 1 60); do
    if docker info >/dev/null 2>&1; then echo " ${GREEN}ready${OFF}"; break; fi
    printf "."
    sleep 2
  done
  if ! docker info >/dev/null 2>&1; then
    echo ""
    echo "${RED}  Docker still isn't answering.${OFF}"
    echo "  Open Docker Desktop from Applications, wait for the whale in the menu bar to stop"
    echo "  animating, then run this again."
    echo ""
    read -r -p "Press Enter to close."
    exit 1
  fi
fi

# --- 3. settings ----------------------------------------------------------
# .env holds the database password and the API keys. Created from the example on first run,
# never overwritten — overwriting it would silently reset the database password on a database
# that still has the old one, and the app would then fail to connect for no visible reason.
if [ ! -f .env ]; then
  cp .env.example .env
  echo "${DIM}  created .env from .env.example${OFF}"
fi

# --- 4. up ----------------------------------------------------------------
echo "Starting CardVault..."
echo "${DIM}  first run downloads Postgres and Redis — a few minutes. After that it's seconds.${OFF}"
echo ""
if ! docker compose up -d; then
  echo ""
  echo "${RED}Something went wrong starting the containers.${OFF}"
  echo "  The output above says what. Copy it into the chat and I'll read it."
  echo ""
  read -r -p "Press Enter to close."
  exit 1
fi

# --- 5. wait for it to actually answer -----------------------------------
# `docker compose up -d` returning success means the CONTAINERS started, not that the app is
# ready — Postgres has to come up, the migration has to run, and the seed has to load 2,521
# cards. Opening the browser on the strength of `up -d` alone shows a connection error and
# looks like a failure, so this waits for a real HTTP answer.
printf "Waiting for it to be ready"
READY=""
for _ in $(seq 1 90); do
  if curl -sf http://localhost:8080/api/health >/dev/null 2>&1; then READY=1; break; fi
  printf "."
  sleep 2
done
echo ""

if [ -z "$READY" ]; then
  echo ""
  echo "${YELLOW}It's taking longer than expected.${OFF}"
  echo "  The first start loads 2,521 cards, which can take a few minutes."
  echo "  Watch what it's doing with:"
  echo ""
  echo "      docker compose logs -f api"
  echo ""
  read -r -p "Press Enter to close."
  exit 1
fi

echo ""
echo "${GREEN}CardVault is running.${OFF}"
echo ""
echo "    ${BOLD}http://localhost:8080${OFF}"
echo ""
echo "  Opening it now. ${BOLD}Bookmark it${OFF} — don't open index.html from the folder,"
echo "  that's only the screen and it can't work on its own."
echo ""
echo "  To stop it later:  docker compose down       ${DIM}(your cards are kept)${OFF}"
echo ""
open http://localhost:8080
sleep 1
