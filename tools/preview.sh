#!/usr/bin/env bash
# Boot the API, snapshot it into a single self-contained preview file, shut down.
set +e
cd "$(dirname "$0")/.."

PORT_N=${PORT_N:-8161}
OUT=${OUT:-cardvault-preview.html}

export DATABASE_URL="${DATABASE_URL:-postgresql://cardvault:cardvault@127.0.0.1:5433/cardvault}"
export REDIS_URL="${REDIS_URL:-redis://127.0.0.1:6379}"
export PORT="$PORT_N"
# Respect a caller-supplied cache dir; portraits and photos live there.
export IMAGE_CACHE_DIR="${IMAGE_CACHE_DIR:-/tmp/cv-img-$PORT_N}"

pkill -9 -f "tsx src/server.ts" 2>/dev/null
fuser -k -n tcp "$PORT_N" 2>/dev/null
sleep 2

npx tsx src/server.ts > /tmp/preview-srv.log 2>&1 &
SRV=$!
for i in $(seq 1 40); do
  curl -sf "localhost:$PORT_N/api/health" >/dev/null 2>&1 && break
  sleep 1
done

# A stale server on this port would be captured silently, producing a preview built
# from whatever code was running an hour ago. Refuse instead.
if grep -q EADDRINUSE /tmp/preview-srv.log 2>/dev/null; then
  echo "FATAL: port $PORT_N was already held — the capture would have used a stale server."
  kill -9 $SRV 2>/dev/null
  exit 1
fi

node tools/build-preview.mjs "http://localhost:$PORT_N" "$OUT"
kill -9 $SRV 2>/dev/null
exit 0
