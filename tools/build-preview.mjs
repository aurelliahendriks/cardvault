/**
 * Build a single self-contained preview of the dashboard.
 *
 * Captures the live API responses, embeds them, and installs a shim that
 * resolves `fetch` from the embedded snapshot instead of the network. The
 * application code runs completely unmodified — the shim only swaps its data
 * source, so what you click through is the real UI, not a mock of it.
 *
 *   node tools/build-preview.mjs http://localhost:8155 preview.html
 */
import { readFile, writeFile } from 'node:fs/promises';

const BASE = process.argv[2] ?? 'http://localhost:8155';
const OUT = process.argv[3] ?? 'cardvault-preview.html';

const ENDPOINTS = [
  '/api/health',
  '/api/overview',
  '/api/facets',
  '/api/portfolio',
  '/api/communities',
  '/api/marketplaces',
  '/api/health/sources',
  '/api/health/runs?limit=50',
  '/api/recommendations?limit=250',
  '/api/sales',
  '/api/alerts',
  '/api/where-to-sell?grossAud=100&useAds=false',
  '/api/where-to-sell?grossAud=100&useAds=true',
  '/api/boxes',
  '/api/sections',
  '/api/parallels',
  '/api/players?view=owned&sort=value&limit=300',
  '/api/players?view=all&sort=value&limit=300',
  '/api/players?view=hot&sort=value&limit=300',
  '/api/clubs/health',
  '/api/shadow',
  '/api/players/portraits/status',
];

// One capture per view. The six sort orders are the same rows in a different
// sequence, so the shim reorders them locally — capturing all 30 permutations made
// the file six times larger for no extra information.
const VIEWS = ['owned', 'actions', 'hot', 'movers', 'all'];
for (const view of VIEWS) {
  ENDPOINTS.push(`/api/gallery?view=${view}&sort=value&limit=180`);
}

const data = {};
for (const ep of ENDPOINTS) {
  const res = await fetch(BASE + ep);
  data[ep] = res.ok ? await res.json() : null;
  process.stderr.write(`  ${res.status} ${ep}\n`);
}

// Card detail for everything the gallery can surface, so the lightbox works.
const skus = new Set();
for (const [k, v] of Object.entries(data)) {
  if (k.startsWith('/api/gallery') && Array.isArray(v)) v.forEach((r) => skus.add(r.sku_id));
}
for (const v of data['/api/portfolio']?.rows ?? []) skus.add(v.sku_id);
for (const sku of skus) {
  const res = await fetch(`${BASE}/api/cards/${sku}`);
  if (res.ok) data[`/api/cards/${sku}`] = await res.json();
}
process.stderr.write(`  ${skus.size} card details\n`);

// Capture the server's own artwork per SKU. An earlier version reimplemented the
// SVG generator inside the shim, which meant every change to the real art had to
// be mirrored by hand or the preview quietly drifted out of date.
const images = {};
for (const sku of skus) {
  const res = await fetch(`${BASE}/api/img/${sku}`);
  if (!res.ok) continue;
  const ct = res.headers.get('content-type') || '';
  if (!ct.includes('svg')) continue;              // real photos are not embeddable here
  images[sku] = (await res.text()).replace(/\n\s*/g, ' ').trim();
}
process.stderr.write(`  ${Object.keys(images).length} card artworks\n`);

// Player pages + avatars, so the player-first view works offline too.
// Avatars for every player in the grid (they are small), but full pages only for the
// ones you would plausibly open — otherwise 300+ page payloads dominate the file.
const players = new Set();
for (const [k, v] of Object.entries(data)) {
  if (k.startsWith('/api/players?') && Array.isArray(v)) v.forEach((r) => players.add(r.player));
}
const pageFor = new Set([
  ...(data['/api/players?view=owned&sort=value&limit=300'] ?? []).map((r) => r.player),
  ...(data['/api/players?view=hot&sort=value&limit=300'] ?? []).slice(0, 40).map((r) => r.player),
  ...(data['/api/players?view=all&sort=value&limit=300'] ?? []).slice(0, 40).map((r) => r.player),
]);
for (const name of players) {
  const ar = await fetch(`${BASE}/api/img/player/${encodeURIComponent(name)}`);
  if (ar.ok && (ar.headers.get('content-type') || '').includes('svg')) {
    images['player:' + name] = (await ar.text()).replace(/\n\s*/g, ' ').trim();
  }
  if (!pageFor.has(name)) continue;
  const pr = await fetch(`${BASE}/api/players/${encodeURIComponent(name)}`);
  if (pr.ok) data[`/api/players/${encodeURIComponent(name)}`] = await pr.json();
}
process.stderr.write(`  ${players.size} avatars, ${pageFor.size} player pages\n`);

const SHIM = `
<script>
/* ---------------------------------------------------------------------------
   Offline preview shim.

   The dashboard code below is byte-for-byte the deployed application. This
   block only redirects its data source: fetch() resolves from the embedded
   snapshot, and card images are generated client-side rather than requested.
   Writes are acknowledged and then ignored, since there is no database here.
   --------------------------------------------------------------------------- */
window.__PREVIEW__ = true;
const SNAP = window.__SNAPSHOT__;

/* sku -> card metadata, harvested from every embedded response. */
const META = {};
for (const [k, v] of Object.entries(SNAP)) {
  if (k.startsWith('/api/gallery') && Array.isArray(v)) {
    for (const r of v) META[r.sku_id] = r;
  }
}
for (const r of (SNAP['/api/portfolio'] || {}).rows || []) META[r.sku_id] ??= r;
for (const [k, v] of Object.entries(SNAP)) {
  if (k.startsWith('/api/cards/') && v && v.detail) META[v.detail.sku_id] ??= v.detail;
}

/* Artwork is whatever the server rendered at capture time — not a reimplementation. */
const ART = window.__ARTWORK__ || {};
const FALLBACK = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 250 350">'
  + '<rect width="250" height="350" rx="8" fill="#232321"/></svg>';
const imgCache = {};
function imgFor(sku, still) {
  const key = still ? sku + '#still' : sku;
  if (!imgCache[key]) {
    let svg = ART[sku] || FALLBACK;
    // The motion is one <style> block, so a still is the same document without it.
    if (still) svg = svg.replace(/<style>[\\s\\S]*?<\\/style>/g, '');
    imgCache[key] = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  }
  return imgCache[key];
}

/* <img src="/api/img/123"> never goes through fetch, so rewrite it in the DOM. */
function rewriteImages(root) {
  const imgs = (root.querySelectorAll ? root.querySelectorAll('img[src*="/api/img/"]') : []);
  imgs.forEach((el) => {
    const src = el.getAttribute('src') || '';
    // Player avatars are keyed by name, not by a numeric sku — an earlier version
    // only matched the numeric form and left every face in the grid broken.
    // Strip the query first: the dashboard appends ?anim=0 under reduced motion, and
    // that would otherwise become part of the player's name and miss the snapshot.
    const pm = /\\/api\\/img\\/player\\/([^?]+)/.exec(src);
    if (pm) {
      el.src = imgFor('player:' + decodeURIComponent(pm[1]), /[?&]anim=0/.test(src));
      return;
    }
    const m = /\\/api\\/img\\/(\\d+)/.exec(src);
    if (m) el.src = imgFor(m[1]);
  });
}
new MutationObserver((muts) => {
  for (const mut of muts) {
    for (const n of mut.addedNodes) if (n.nodeType === 1) rewriteImages(n);
    if (mut.type === 'attributes' && mut.target.tagName === 'IMG') rewriteImages(mut.target.parentNode || document);
  }
}).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] });

const jsonResponse = (body) => new Response(JSON.stringify(body), {
  status: 200, headers: { 'Content-Type': 'application/json' },
});

const realFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : (input && input.url) || '';
  const path = url.replace(/^https?:\\/\\/[^/]+/, '');
  const method = ((init && init.method) || 'GET').toUpperCase();

  if (!path.startsWith('/api/')) return realFetch(input, init);

  if (path.startsWith('/api/img/player/')) {
    const name = decodeURIComponent(path.replace('/api/img/player/', '').split('?')[0]);
    let svg = ART['player:' + name] || FALLBACK;
    // Only one variant is captured, so honour ?anim=0 by removing the animation from it.
    // All the motion lives in a single <style> block inside the SVG, which makes this a
    // safe strip rather than a guess — and without it the static preview would ignore a
    // reader's reduced-motion setting, which is exactly the bug the live app just fixed.
    if (/[?&]anim=0/.test(path)) svg = svg.replace(/<style>[\\s\\S]*?<\\/style>/g, '');
    return new Response(svg, { status: 200, headers: { 'Content-Type': 'image/svg+xml' } });
  }
  if (path.startsWith('/api/img/preview')) {
    // The add dialog's live artwork needs a live renderer, which a static file
    // cannot provide. Show the base card's art and say so in the caption.
    return new Response(FALLBACK, { status: 200, headers: { 'Content-Type': 'image/svg+xml' } });
  }
  if (path.startsWith('/api/img/')) {
    const m = /\\/api\\/img\\/(\\d+)/.exec(path);
    return new Response(m ? (ART[m[1]] || FALLBACK) : FALLBACK, {
      status: 200, headers: { 'Content-Type': 'image/svg+xml' },
    });
  }

  if (method !== 'GET') {
    // No database in a static file. Acknowledge, change nothing, and say so.
    setTimeout(() => {
      const el = document.getElementById('toast');
      if (el) {
        el.textContent = 'Preview mode — this would write to the database in the real app.';
        el.style.opacity = 1;
        setTimeout(() => el.style.opacity = 0, 3200);
      }
    }, 30);
    if (path === '/api/ask') {
      return jsonResponse({
        question: (init && JSON.parse(init.body).question) || '',
        sql: null, rows: [], rowCount: 0, ms: 0,
        answer: 'Natural-language search runs server-side against Postgres, so it is inert in this static preview. '
          + 'In the real app it writes a read-only SELECT, runs it behind a whitelist and a statement timeout, then narrates the rows.',
      });
    }
    return jsonResponse({ ok: true, preview: true });
  }

  if (SNAP[path] !== undefined) return jsonResponse(SNAP[path]);

  // player -> {position, club}, assembled once from the players snapshot. Without it
  // the two new filters would silently do nothing in the static preview, which is
  // worse than not offering them: a filter that appears to work and doesn't is a lie.
  if (!globalThis.__PMETA) {
    const meta = new Map();
    for (const k of Object.keys(SNAP)) {
      if (!k.startsWith('/api/players?') || !Array.isArray(SNAP[k])) continue;
      for (const r of SNAP[k]) if (r && r.player) meta.set(r.player, r);
    }
    globalThis.__PMETA = meta;
  }
  const PMETA = globalThis.__PMETA;
  const metaMatch = (playerName, key, want) => {
    if (!want) return true;
    const v = (PMETA.get(playerName) || {})[key] || null;
    return want === 'unknown' ? v == null : v === want;
  };

  if (path.startsWith('/api/gallery')) {
    const p = new URLSearchParams(path.split('?')[1] || '');
    const key = '/api/gallery?view=' + (p.get('view') || 'owned') + '&sort=value&limit=180';
    let rows = (SNAP[key] || SNAP['/api/gallery?view=owned&sort=value&limit=180'] || []).slice();
    const search = (p.get('search') || '').toLowerCase();
    const section = p.get('section'), team = p.get('team'), minValue = Number(p.get('minValue'));
    if (search) rows = rows.filter((r) => ((r.player || '') + ' ' + (r.team || '') + ' ' + (r.label || '')).toLowerCase().includes(search));
    if (section) rows = rows.filter((r) => r.section === section);
    if (team) rows = rows.filter((r) => r.team === team);
    if (p.get('position')) rows = rows.filter((r) => metaMatch(r.player, 'position', p.get('position')));
    if (p.get('club')) rows = rows.filter((r) => metaMatch(r.player, 'club', p.get('club')));
    if (minValue) rows = rows.filter((r) => Number(r.value_aud || 0) >= minValue);

    // Same rows, requested order.
    const num = (v) => (v == null ? -Infinity : Number(v));
    const SORTERS = {
      value:  (a, b) => num(b.value_aud) - num(a.value_aud),
      stakes: (a, b) => num(b.score) - num(a.score),
      trend:  (a, b) => num(b.trend_30d_pct) - num(a.trend_30d_pct),
      comps:  (a, b) => num(b.n_comps) - num(a.n_comps),
      player: (a, b) => String(a.player || '').localeCompare(String(b.player || '')),
      number: (a, b) => String(a.product_code).localeCompare(String(b.product_code))
                      || String(a.section || '').localeCompare(String(b.section || ''))
                      || String(a.card_number || '').padStart(6, '0')
                         .localeCompare(String(b.card_number || '').padStart(6, '0')),
    };
    rows.sort(SORTERS[p.get('sort') || 'value'] || SORTERS.value);
    return jsonResponse(rows);
  }
  if (path.startsWith('/api/players/') && !path.includes('portraits')) {
    const key = '/api/players/' + path.replace('/api/players/', '').split('?')[0];
    return jsonResponse(SNAP[key] ?? null);
  }
  if (path.startsWith('/api/players?') || path === '/api/players') {
    const p = new URLSearchParams(path.split('?')[1] || '');
    const view = p.get('view') || 'owned';
    let rows = (SNAP['/api/players?view=' + view + '&sort=value&limit=300']
      || SNAP['/api/players?view=owned&sort=value&limit=300'] || []).slice();
    const search = (p.get('search') || '').toLowerCase();
    if (search) rows = rows.filter((r) => ((r.player || '') + ' ' + (r.team || '')).toLowerCase().includes(search));
    if (p.get('team')) rows = rows.filter((r) => r.team === p.get('team'));
    if (p.get('position')) {
      const want = p.get('position');
      rows = rows.filter((r) => (want === 'unknown' ? !r.position : r.position === want));
    }
    if (p.get('club')) {
      const want = p.get('club');
      rows = rows.filter((r) => (want === 'unknown' ? !r.club : r.club === want));
    }
    const num = (v) => (v == null ? -Infinity : Number(v));
    const S = {
      value: (a, b) => num(b.value_aud) - num(a.value_aud),
      cards: (a, b) => num(b.cards) - num(a.cards) || num(b.value_aud) - num(a.value_aud),
      name:  (a, b) => String(a.player).localeCompare(String(b.player)),
      trend: (a, b) => num(b.trend_30d_pct) - num(a.trend_30d_pct),
    };
    rows.sort(S[p.get('sort') || 'value'] || S.value);
    return jsonResponse(rows);
  }
  if (path.startsWith('/api/parallels')) {
    const p = new URLSearchParams(path.split('?')[1] || '');
    let rows = SNAP['/api/parallels'] || [];
    if (p.get('product')) rows = rows.filter((r) => r.product_code === p.get('product'));
    if (p.get('section')) rows = rows.filter((r) => r.section === p.get('section'));
    return jsonResponse(rows);
  }
  if (path.startsWith('/api/where-to-sell')) {
    return jsonResponse(SNAP['/api/where-to-sell?grossAud=100&useAds=false']);
  }
  if (path.startsWith('/api/recommendations')) {
    const p = new URLSearchParams(path.split('?')[1] || '');
    let rows = SNAP['/api/recommendations?limit=250'] || [];
    if (p.get('action')) rows = rows.filter((r) => r.action === p.get('action'));
    return jsonResponse(rows);
  }
  return jsonResponse(null);
};
</script>
`;

const BANNER = `
<div style="background:#1c2a1c;border-bottom:1px solid rgba(255,255,255,.12);
     padding:9px 18px;font:12.5px system-ui,-apple-system,'Segoe UI',sans-serif;color:#c3c2b7">
  <b style="color:#fff">Static preview.</b>
  Real UI, real code, a frozen snapshot of the demo database — click anything.
  Card art is generated per version (no photos harvested yet) — Base, Optic, Kaboom,
  parallels and graded slabs each render differently, and scarcity is drawn as a CSS
  effect over that art (see the ladder under Data &amp; sources). Player avatars are
  kit-coloured figures posed by position — a keeper dives, a striker shoots. The add
  dialog's live artwork preview needs the server, so it shows a placeholder here. “Where to sell” is fixed
  at a A$100 sale price, and anything that would write to the database is
  acknowledged but inert. The nation, position and club filters work here — they run
  against the frozen snapshot rather than the database.
</div>
`;

let html = await readFile('web/index.html', 'utf8');
html = html.replace('<title>', '<title>Preview · ');
html = html.replace('<body>', '<body>' + BANNER);
// Snapshot + shim must run before the app script.
html = html.replace('<script>\n\'use strict\';',
  `<script>window.__SNAPSHOT__ = ${JSON.stringify(data)};`
  + `\nwindow.__ARTWORK__ = ${JSON.stringify(images)};</script>\n${SHIM}\n<script>\n'use strict';`);

await writeFile(OUT, html);
process.stderr.write(`\nwrote ${OUT} (${(Buffer.byteLength(html) / 1024).toFixed(0)} KB)\n`);
