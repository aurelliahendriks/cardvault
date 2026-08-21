#!/usr/bin/env bash
# Verify that the generated card artwork actually changes with the chosen version.
set +e
cd "$(dirname "$0")/.."

PORT_N=${PORT_N:-8193}
export DATABASE_URL="${DATABASE_URL:-postgresql://cardvault:cardvault@127.0.0.1:5433/cardvault}"
export REDIS_URL="${REDIS_URL:-redis://127.0.0.1:6379}"
export PORT="$PORT_N"
export IMAGE_CACHE_DIR="/tmp/cv-art-$PORT_N"

pkill -9 -f "tsx src/server.ts" 2>/dev/null
fuser -k -n tcp "$PORT_N" 2>/dev/null
sleep 2

npx tsx src/server.ts > /tmp/verify-art-srv.log 2>&1 &
SRV=$!
for i in $(seq 1 45); do
  curl -sf "localhost:$PORT_N/api/health" >/dev/null 2>&1 && break
  sleep 1
done

if ! curl -sf "localhost:$PORT_N/api/health" >/dev/null 2>&1; then
  echo "FATAL: server did not start"
  tail -12 /tmp/verify-art-srv.log
  exit 0
fi

echo "=== render-only preview endpoint: each version must differ ==="
for q in \
  "section=Base&player=Ada+Lovelace" \
  "section=Base+Optic&player=Ada+Lovelace" \
  "section=Kaboom!&player=Ada+Lovelace" \
  "section=Signature+Series&player=Ada+Lovelace" \
  "section=Night+Moves&player=Ada+Lovelace" \
  "section=Base&player=Ada+Lovelace&parallelName=Gold&printRun=10" \
  "section=Base&player=Ada+Lovelace&parallelName=Teal&printRun=199" \
  "section=Base&player=Ada+Lovelace&grader=PSA&grade=10"; do
  out="/tmp/artq-$(echo "$q" | md5sum | cut -c1-6).svg"
  curl -s "localhost:$PORT_N/api/img/preview?$q" -o "$out"
  printf "  %-56s %5s bytes  sha=%s\n" "$q" "$(wc -c < "$out")" "$(md5sum "$out" | cut -c1-8)"
done
echo "  distinct renders: $(md5sum /tmp/artq-*.svg | awk '{print $1}' | sort -u | wc -l) of $(ls /tmp/artq-*.svg | wc -l)"

echo "=== browser: artwork updates live in the add dialog ==="
mkdir -p /tmp/shots
B="http://localhost:$PORT_N" node tools/check-art.mjs 2>&1 | tail -14

kill -9 $SRV 2>/dev/null
exit 0
