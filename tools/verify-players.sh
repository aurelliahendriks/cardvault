#!/usr/bin/env bash
# Verify the player-first collection view, and that a portrait actually composites.
set +e
cd "$(dirname "$0")/.."

PORT_N=${PORT_N:-8195}
export DATABASE_URL="${DATABASE_URL:-postgresql://cardvault:cardvault@127.0.0.1:5433/cardvault}"
export REDIS_URL="${REDIS_URL:-redis://127.0.0.1:6379}"
export PORT="$PORT_N"
export IMAGE_CACHE_DIR="/tmp/cv-players-$PORT_N"

pkill -9 -f "tsx src/server.ts" 2>/dev/null
fuser -k -n tcp "$PORT_N" 2>/dev/null
sleep 2

npx tsx src/server.ts > /tmp/verify-players-srv.log 2>&1 &
SRV=$!
for i in $(seq 1 45); do
  curl -sf "localhost:$PORT_N/api/health" >/dev/null 2>&1 && break
  sleep 1
done
if ! curl -sf "localhost:$PORT_N/api/health" >/dev/null 2>&1; then
  echo "FATAL: server did not start"; tail -12 /tmp/verify-players-srv.log; exit 0
fi

echo "=== portrait compositing (network to Commons is blocked here, so inject one) ==="
# A recognisable synthetic portrait: a coloured PNG with a lighter oval, so it is
# obvious in the render whether the image landed and how it was cropped.
PORTRAIT=$(python3 - <<'PY'
import base64, zlib, struct
W = H = 240
def px(x, y):
    cx, cy = W/2, H*0.42
    inside = ((x-cx)/62)**2 + ((y-cy)/78)**2 <= 1
    return (238, 226, 205) if inside else (36, 84, 132)
raw = b''.join(b'\x00' + bytes(v for x in range(W) for v in px(x, y)) for y in range(H))
def chunk(t, d):
    c = t + d
    return struct.pack('>I', len(d)) + c + struct.pack('>I', zlib.crc32(c) & 0xffffffff)
png = (b'\x89PNG\r\n\x1a\n'
       + chunk(b'IHDR', struct.pack('>IIBBBBB', W, H, 8, 2, 0, 0, 0))
       + chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b''))
print('data:image/png;base64,' + base64.b64encode(png).decode())
PY
)
for who in "Lamine Yamal" "Lionel Messi" "Gilberto Mora"; do
  enc=$(python3 -c "import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1]))" "$who")
  code=$(curl -s -o /tmp/pp.json -w '%{http_code}' -X POST "localhost:$PORT_N/api/players/$enc/portrait" \
    -H 'Content-Type: application/json' \
    -d "{\"photo\":\"$PORTRAIT\",\"author\":\"Test Fixture\",\"license\":\"CC BY-SA 4.0\",\"licenseUrl\":\"https://creativecommons.org/licenses/by-sa/4.0\",\"creditUrl\":\"https://example.org/file\"}")
  echo "  set portrait for $who -> HTTP $code $(head -c 80 /tmp/pp.json)"
done

echo "=== avatar and card art now carry the portrait ==="
enc=$(python3 -c "import urllib.parse;print(urllib.parse.quote('Lamine Yamal'))")
curl -sI "localhost:$PORT_N/api/img/player/$enc" | grep -iE "content-type|x-image-source" | sed 's/^/  /'
SKU=$(psql "$DATABASE_URL" -tAc "SELECT s.id FROM skus s JOIN cards c ON c.id=s.card_id WHERE c.player='Lamine Yamal' LIMIT 1")
curl -sI "localhost:$PORT_N/api/img/$SKU" | grep -iE "x-image-source" | sed 's/^/  card art: /'
echo "  avatar has an <image>: $(curl -s "localhost:$PORT_N/api/img/player/$enc" | grep -c '<image')"
echo "  card art has an <image>: $(curl -s "localhost:$PORT_N/api/img/$SKU" | grep -c '<image')"

echo "=== players API ==="
curl -s "localhost:$PORT_N/api/players?view=owned&sort=value" | python3 -c "
import json,sys
rows=json.load(sys.stdin)
print(f'  {len(rows)} players owned')
for r in rows[:6]:
    print('   %-20s %-14s cards=%-3s versions=%-2s value=%-10s portrait=%s' % (
      r['player'][:20], (r['team'] or '')[:14], r['cards'], r['versions_owned'],
      r['value_aud'], r['portrait_status']))"
curl -s "localhost:$PORT_N/api/players/Lamine%20Yamal" | python3 -c "
import json,sys
d=json.load(sys.stdin)
print('  page: owned=%d missing=%d totals=%s' % (len(d['owned']), len(d['missing']),
  {k:d['totals'][k] for k in ('cards','versions','value_aud')}))
print('  attribution:', d['player'].get('author'), '|', d['player'].get('license'), '|', d['player'].get('credit_url'))"

echo "=== browser ==="
mkdir -p /tmp/shots
B="http://localhost:$PORT_N" node tools/check-players.mjs 2>&1 | tail -18

kill -9 $SRV 2>/dev/null
exit 0
