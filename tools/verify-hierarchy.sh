#!/usr/bin/env bash
# Does the rarity ladder read as a ladder? Measured, not eyeballed.
set +e
cd "$(dirname "$0")/.."
PORT_N=${PORT_N:-8183}
export DATABASE_URL="${DATABASE_URL:-postgresql://cardvault:cardvault@127.0.0.1:5433/cardvault}"
export REDIS_URL="${REDIS_URL:-redis://127.0.0.1:6379}"
export PORT="$PORT_N"
export IMAGE_CACHE_DIR="/tmp/cv-hier-$PORT_N"

pkill -9 -f "tsx src/server.ts" 2>/dev/null
fuser -k -n tcp "$PORT_N" 2>/dev/null
sleep 2
npx tsx src/server.ts > /tmp/verify-hier-srv.log 2>&1 &
SRV=$!
for i in $(seq 1 45); do curl -sf "localhost:$PORT_N/api/health" >/dev/null 2>&1 && break; sleep 1; done
if ! curl -sf "localhost:$PORT_N/api/health" >/dev/null 2>&1; then
  echo "FATAL: server did not start"; tail -15 /tmp/verify-hier-srv.log; exit 1
fi

RC=0
for spec in "m motion" "s motion" "m reduced" "m off" "m graded"; do
  set -- $spec
  SIZE=$1 MODE=$2
  echo "=== ladder: $( [ "$SIZE" = s ] && echo 'small tiles' || echo 'normal tiles' ), $MODE ==="
  OUT="/tmp/shots/hier-$SIZE-$MODE"
  B="http://localhost:$PORT_N" OUT="$OUT" SIZE="$SIZE" MODE="$MODE" \
    node tools/check-hierarchy.mjs > /dev/null 2>/tmp/hier-cap.log || { cat /tmp/hier-cap.log; RC=1; continue; }
  python3 tools/measure-hierarchy.py "$OUT/manifest.json" 3.0 2>&1 | tail -26 | sed 's/^/ /'
  [ ${PIPESTATUS[0]} -ne 0 ] && RC=1
  echo
done

echo "=== legibility over every effect ==="
B="http://localhost:$PORT_N" node tools/check-legibility.mjs 2>&1 | tail -20
[ $? -ne 0 ] && RC=1

kill -9 $SRV 2>/dev/null
exit $RC
