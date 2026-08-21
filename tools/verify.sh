#!/usr/bin/env bash
# One-shot verification: boot the API, probe it, screenshot every tab, shut down.
set +e
cd "$(dirname "$0")/.."

PORT_N=${PORT_N:-8155}
export DATABASE_URL="postgresql://cardvault:cardvault@127.0.0.1:5433/cardvault"
export REDIS_URL="redis://127.0.0.1:6379"
export PORT="$PORT_N"
export IMAGE_CACHE_DIR="/tmp/cv-img-$PORT_N"

pkill -9 -f "tsx src/server.ts" 2>/dev/null
sleep 2

npx tsx src/server.ts > /tmp/verify-srv.log 2>&1 &
SRV=$!

for i in $(seq 1 40); do
  curl -sf "localhost:$PORT_N/api/health" >/dev/null 2>&1 && break
  sleep 1
done

echo "=== health ==="
curl -s "localhost:$PORT_N/api/health" | head -c 130; echo

echo "=== placeholder SVG: text elements (expect exactly 1, the monogram) ==="
curl -s "localhost:$PORT_N/api/img/503" | grep -o '<text[^>]*>[^<]*</text>' | sed 's/<[^>]*>//g' | sed 's/^/  text: /'

echo "=== gallery: method must never be null when a value exists ==="
curl -s "localhost:$PORT_N/api/gallery?view=owned&limit=8" \
  | python3 -c "import json,sys
rows=json.load(sys.stdin)
for r in rows: print('  %-20s value=%-10s method=%s' % (r['player'][:20], r['value_aud'], r['method']))
bad=[r for r in rows if r['value_aud'] is not None and not r['method']]
print('  NULL-method rows with a value:', len(bad))"

echo "=== screenshots ==="
sed -i "s|localhost:[0-9]*/|localhost:$PORT_N/|" tools/screenshot.mjs
rm -rf /tmp/shots; mkdir -p /tmp/shots
node tools/screenshot.mjs 2>&1 | tail -8

kill -9 $SRV 2>/dev/null
echo "=== files ==="
ls -1 /tmp/shots/
exit 0
