#!/usr/bin/env bash
# Verify poses, the pose endpoints, and the rarity effect layer.
set +e
cd "$(dirname "$0")/.."
PORT_N=${PORT_N:-8181}
export DATABASE_URL="${DATABASE_URL:-postgresql://cardvault:cardvault@127.0.0.1:5433/cardvault}"
export REDIS_URL="${REDIS_URL:-redis://127.0.0.1:6379}"
export PORT="$PORT_N"
export IMAGE_CACHE_DIR="/tmp/cv-fx-$PORT_N"

pkill -9 -f "tsx src/server.ts" 2>/dev/null
fuser -k -n tcp "$PORT_N" 2>/dev/null
sleep 2
npx tsx src/server.ts > /tmp/verify-fx-srv.log 2>&1 &
SRV=$!
for i in $(seq 1 45); do curl -sf "localhost:$PORT_N/api/health" >/dev/null 2>&1 && break; sleep 1; done
if ! curl -sf "localhost:$PORT_N/api/health" >/dev/null 2>&1; then
  echo "FATAL: server did not start"; tail -15 /tmp/verify-fx-srv.log; exit 0
fi

echo "=== /api/poses ==="
curl -s "localhost:$PORT_N/api/poses" | python3 -c "
import json,sys
for r in json.load(sys.stdin): print('  %-12s %-18s %d players' % (r['pose'], r['label'], r['players']))"

echo "=== position -> pose on the avatar route ==="
for who in "Thibaut Courtois" "Virgil van Dijk" "Lamine Yamal" "Jude Bellingham" "Harry Kane" "Ronaldo"; do
  enc=$(python3 -c "import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1]))" "$who")
  pose=$(curl -sI "localhost:$PORT_N/api/img/player/$enc" | grep -i '^x-pose' | tr -d '\r' | cut -d' ' -f2)
  echo "  $(printf '%-18s' "$who") -> ${pose:-none}"
done

echo "=== pinning a pose ==="
curl -s -X POST "localhost:$PORT_N/api/players/Lionel%20Messi/pose" \
  -H 'Content-Type: application/json' -d '{"pose":"celebrating"}' | head -c 160; echo
curl -sI "localhost:$PORT_N/api/img/player/Lionel%20Messi" | grep -i '^x-pose' | sed 's/^/  after pin: /' | tr -d '\r'
echo -n "  bad pose rejected: "
curl -s -o /tmp/bad.json -w '%{http_code}' -X POST "localhost:$PORT_N/api/players/Lionel%20Messi/pose" \
  -H 'Content-Type: application/json' -d '{"pose":"nope"}'; echo " $(head -c 90 /tmp/bad.json)"
echo -n "  unknown player 404s: "
curl -s -o /dev/null -w '%{http_code}\n' -X POST "localhost:$PORT_N/api/players/Nobody%20At%20All/pose" \
  -H 'Content-Type: application/json' -d '{"pose":"running"}'
curl -s -X POST "localhost:$PORT_N/api/players/Lionel%20Messi/pose" \
  -H 'Content-Type: application/json' -d '{"pose":null}' > /dev/null

echo "=== browser ==="
mkdir -p /tmp/shots
B="http://localhost:$PORT_N" node tools/check-fx.mjs 2>&1 | tail -22

kill -9 $SRV 2>/dev/null
exit 0
