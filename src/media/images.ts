import { createHash } from 'node:crypto';
import { figureSvg, poseForPosition, type PoseName } from './poses.js';
import { avatarStyle, backdropSvg, motionCss } from './avatarStyle.js';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { q, one } from '../db.js';
import { log } from '../logger.js';

/**
 * Card imagery, harvested from the market data we already collect.
 *
 * There is no card-image API for these sets, and scraping an image host would be
 * a separate legal and operational problem. But every matched sold listing comes
 * with a photograph of the exact card — so the best image for a SKU is simply the
 * one attached to its highest-confidence recent sale. The gallery is a free
 * by-product of the pricing pipeline.
 *
 * Everything without a photo gets a generated placeholder rather than a broken
 * image icon. That matters more than it sounds: on a cold install there are zero
 * listings, so the placeholder IS the gallery, and 1,771 grey rectangles would
 * make the whole view useless.
 */

const CACHE_DIR = process.env.IMAGE_CACHE_DIR ?? '/tmp/cardvault-images';
const CACHE_TTL_MS = 30 * 86400_000;

/**
 * eBay serves the same photo at several sizes via an `s-lNNN` suffix. Listings
 * usually hand us a thumbnail; ask for a larger one, because a gallery of 225px
 * crops looks like a broken page.
 */
export function upgradeEbayImage(url: string, size = 500): string {
  if (!/i\.ebayimg\.com/.test(url)) return url;
  return url.replace(/\/s-l\d+\.(jpg|jpeg|png|webp)/i, `/s-l${size}.$1`);
}

// ---------------------------------------------------------------------------
// Harvesting
// ---------------------------------------------------------------------------

/**
 * Pick the best image for one SKU.
 *
 * Ranked by match confidence first, then recency. Confidence before recency is
 * deliberate: a photo attached to a shakily-matched listing might be a different
 * card entirely, and a wrong picture is worse than an old one — it will make you
 * misidentify what you own.
 */
export async function resolveSkuImage(skuId: number): Promise<string | null> {
  const row = await one<{ image_url: string; listing_id: number }>(
    `SELECT l.image_url, l.id AS listing_id
       FROM comps c
       JOIN listings l ON l.id = c.listing_id
      WHERE c.sku_id = $1
        AND NOT c.excluded
        AND l.image_url IS NOT NULL
        AND l.image_url <> ''
      ORDER BY c.match_confidence DESC, c.sold_at DESC
      LIMIT 1`,
    [skuId],
  );
  if (!row) return null;

  const url = upgradeEbayImage(row.image_url);
  await q(
    `UPDATE skus SET image_url = $2, image_source = 'listing',
            image_listing_id = $3, image_updated_at = now()
      WHERE id = $1`,
    [skuId, url, row.listing_id],
  );
  return url;
}

/**
 * Harvest images for every SKU that has comps but no picture, then promote a
 * representative image to the card so other versions of the same card have
 * something to inherit.
 */
export async function refreshImages(opts: { limit?: number; onlyMissing?: boolean } = {}) {
  const skus = await q<{ id: number }>(
    opts.onlyMissing === false
      ? `SELECT DISTINCT s.id FROM skus s JOIN comps c ON c.sku_id = s.id
          WHERE NOT c.excluded AND s.id IS NOT NULL LIMIT $1`
      : `SELECT DISTINCT s.id FROM skus s
           JOIN comps c ON c.sku_id = s.id
           JOIN listings l ON l.id = c.listing_id
          WHERE s.image_url IS NULL AND NOT c.excluded
            AND l.image_url IS NOT NULL AND l.image_url <> ''
          LIMIT $1`,
    [opts.limit ?? 3000],
  );

  let found = 0;
  for (const s of skus) if (await resolveSkuImage(s.id)) found++;

  // Promote to the card: prefer the raw base version's photo, since that's the
  // most representative image of the card itself.
  const promoted = await q<{ n: number }>(
    `WITH best AS (
       SELECT DISTINCT ON (s.card_id) s.card_id, s.image_url
         FROM skus s
        WHERE s.image_url IS NOT NULL
        ORDER BY s.card_id,
                 (s.parallel_id IS NULL AND s.grader IS NULL) DESC,
                 s.image_updated_at DESC
     )
     UPDATE cards c SET image_url = b.image_url, image_updated_at = now()
       FROM best b
      WHERE c.id = b.card_id
        AND (c.image_url IS DISTINCT FROM b.image_url)
      RETURNING 1`,
  );

  log.info({ scanned: skus.length, found, cardsPromoted: promoted.length }, 'image harvest complete');
  return { scanned: skus.length, found, cardsPromoted: promoted.length };
}

// ---------------------------------------------------------------------------
// Disk cache + proxy
// ---------------------------------------------------------------------------

export interface CachedImage {
  body: Buffer;
  contentType: string;
  fromCache: boolean;
}

/**
 * Fetch through a disk cache.
 *
 * Proxying rather than hotlinking is the right call here: listing images vanish
 * when listings are deleted, and a gallery that decays into broken thumbnails a
 * month after you build your collection is worthless. The cache also means the
 * page doesn't fire hundreds of cross-origin requests on every scroll.
 */
export async function cachedFetch(url: string): Promise<CachedImage | null> {
  const key = createHash('sha1').update(url).digest('hex');
  const ext = /\.(png|webp|gif)(\?|$)/i.exec(url)?.[1]?.toLowerCase() ?? 'jpg';
  const path = join(CACHE_DIR, `${key}.${ext}`);
  const contentType = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp'
    : ext === 'gif' ? 'image/gif' : 'image/jpeg';

  try {
    const st = await stat(path);
    if (Date.now() - st.mtimeMs < CACHE_TTL_MS) {
      return { body: await readFile(path), contentType, fromCache: true };
    }
  } catch { /* not cached */ }

  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'CardVault/1.0 (personal collection tracker)' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 512) return null;               // 1px tracking gif / error page
    await mkdir(CACHE_DIR, { recursive: true });
    await writeFile(path, buf).catch(() => {});
    return { body: buf, contentType: res.headers.get('content-type') ?? contentType, fromCache: false };
  } catch (e: any) {
    log.debug({ url: url.slice(0, 120), err: e.message }, 'image fetch failed');
    return null;
  }
}

// ---------------------------------------------------------------------------
// Generated placeholders
// ---------------------------------------------------------------------------

/**
 * Section → hue, taken from the validated categorical order so placeholders read
 * as a coherent set rather than random colour. Assignment is by fixed lookup, not
 * by hashing into a cycled palette: the same section is always the same colour,
 * across sessions and across installs.
 */
const SECTION_HUE: Record<string, string> = {
  'Kaboom!': '#d95926',            // slot 2 orange — the marquee insert
  'Kaboom! Oversize': '#d95926',
  'Signature Series': '#9085e9',   // slot 7 violet — autographs
  'Beautiful Game Autographs': '#9085e9',
  'Beautiful Game Dual Autographs': '#9085e9',
  'Night Moves': '#3987e5',        // slot 1 blue
  'Zero Gravity': '#3987e5',
  'Animation': '#199e70',          // slot 3 aqua
  'Elite Series': '#199e70',
  'Craftsmen': '#c98500',          // slot 4 yellow
  'Dominators': '#c98500',
  'Magicians': '#d55181',          // slot 5 magenta
  'Net Marvels': '#d55181',
  'Kit Kings': '#008300',          // slot 6 green
  'Kit Series': '#008300',
  'Pitch Kings': '#008300',
  'Rookie Kings': '#e66767',       // slot 8 red
  'Legend': '#c98500',
  'Legacy': '#9085e9',
  'Golden': '#c98500',
  'Gold Leaf': '#c98500',
  'Glory Cup': '#199e70',
  'Coalition': '#3987e5',
  'Moment': '#d55181',
  'Pictorial': '#199e70',
  'Superstar': '#d95926',
  'Stamp': '#008300',
  'Prizm': '#3987e5',
  'Promotional': '#898781',
};

const BASE_HUE = '#4a5568';   // base cards are the wallpaper; keep them neutral

export interface PlaceholderCard {
  /** cached player portrait as a data URI; inlined because <img>-loaded SVG cannot fetch */
  portraitDataUri?: string | null;
  player: string;
  team: string | null;
  section: string;
  card_number: string;
  product_code: string;
  parallel_name?: string | null;
  grader?: string | null;
  grade?: number | null;
  hot?: boolean;
  subset?: string;
  print_run?: number | null;
}

const esc = (s: string) =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

/**
 * A card-shaped SVG standing in for the real photo. Deliberately looks like a
 * *card* (2.5:3.5, rounded, framed) rather than a generic empty-state box, so a
 * grid of placeholders still reads as a collection at a glance.
 */
/**
 * Card art, generated per card.
 *
 * This is not a generic "no image" box. Choosing Base, Base Optic, Kaboom!, an
 * autograph or a numbered parallel produces visibly different artwork, because the
 * whole point of a picture in a card tracker is telling versions apart at a glance.
 * A real photograph replaces it the moment one is harvested or uploaded — but until
 * then the art still has to carry which version you are looking at.
 *
 * Families:
 *   base      flat slate panel, monogram
 *   optic     prismatic diagonal refractor bands
 *   kaboom    comic starburst rays
 *   auto      dark panel with a signature stroke
 *   insert    section-hue gradient with a radial glow
 * Then, layered on top of any family:
 *   numbered  foil band along the bottom with the print run set large
 *   graded    a slab: outer shell, label strip, grade set large
 */
type ArtFamily = 'base' | 'optic' | 'kaboom' | 'auto' | 'insert';

function familyFor(section: string): ArtFamily {
  const s = section.toLowerCase();
  if (/kaboom/.test(s)) return 'kaboom';
  if (/autograph|signature/.test(s)) return 'auto';
  if (/optic|prizm|refractor|pictorial/.test(s)) return 'optic';
  if (/^base/.test(s)) return 'base';
  return 'insert';
}

export function placeholderSvg(c: PlaceholderCard): string {
  const section = c.section ?? 'Base';
  // Gradient and clip ids must be unique per card. Served through <img> each SVG is
  // its own document and collisions are invisible — but the moment two of these are
  // inlined in one page (a contact sheet, an email, a print layout) every card after
  // the first silently adopts the first one's gradient. Cheap to prevent.
  const portraitPresent = c.portraitDataUri != null;
  const uid = 'a' + createHash('sha1')
    .update([section, c.player, c.card_number, c.parallel_name, c.grader, c.grade,
             portraitPresent ? 'p' : 'm'].join('|'))
    .digest('hex').slice(0, 8);
  const ID = { clip: `c${uid}`, grad: `g${uid}`, sheen: `s${uid}`,
               face: `f${uid}`, fade: `d${uid}` };
  const family = familyFor(section);
  const hue = /^base$/i.test(section) ? BASE_HUE : (SECTION_HUE[section] ?? '#3987e5');
  const initials = (c.player ?? '').split(/\s+/).filter(Boolean).slice(0, 2)
    .map((w) => w[0]!.toUpperCase()).join('');
  const run = c.print_run ?? null;
  const graded = c.grader != null;

  // A parallel shifts the artwork's hue so a Gold /10 does not look like a Teal
  // /199 of the same card. Derived from the name so it is stable across sessions.
  const parHue = c.parallel_name ? parallelHue(c.parallel_name) : null;
  const main = parHue ?? hue;

  const body: string[] = [];
  const portrait = c.portraitDataUri ?? null;

  // ---- family artwork ----------------------------------------------------
  if (family === 'optic') {
    // Refractor: hard-edged diagonal bands, the way an Optic card catches light.
    const bands = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => {
      const x = -60 + i * 52;
      const op = (0.30 + (i % 3) * 0.16).toFixed(2);
      const col = [main, '#ffffff', shift(main, 28), '#ffffff'][i % 4];
      return `<rect x="${x}" y="-40" width="26" height="440" fill="${col}" fill-opacity="${op}" transform="rotate(18 125 175)"/>`;
    }).join('');
    body.push(`<rect x="4" y="4" width="242" height="342" rx="7" fill="${shift(main, -40)}"/>`,
      `<g clip-path="url(#${ID.clip})">${bands}</g>`);
  } else if (family === 'kaboom') {
    // Comic starburst: the Kaboom design language is rays out of the centre.
    const rays = Array.from({ length: 24 }, (_, i) => {
      const a = (i * 15) * Math.PI / 180;
      const w = i % 2 ? 9 : 17;
      const x1 = 125 + Math.cos(a) * 26, y1 = 175 + Math.sin(a) * 26;
      const x2 = 125 + Math.cos(a) * 300, y2 = 175 + Math.sin(a) * 300;
      const x3 = 125 + Math.cos(a + w * Math.PI / 180) * 300;
      const y3 = 175 + Math.sin(a + w * Math.PI / 180) * 300;
      return `<polygon points="${x1.toFixed(1)},${y1.toFixed(1)} ${x2.toFixed(1)},${y2.toFixed(1)} ${x3.toFixed(1)},${y3.toFixed(1)}"
        fill="${i % 2 ? '#ffffff' : shift(main, 45)}" fill-opacity="${i % 2 ? 0.13 : 0.42}"/>`;
    }).join('');
    body.push(`<rect x="4" y="4" width="242" height="342" rx="7" fill="${shift(main, -22)}"/>`,
      `<g clip-path="url(#${ID.clip})">${rays}</g>`,
      `<circle cx="125" cy="175" r="74" fill="${shift(main, 18)}" fill-opacity="0.55"/>`);
  } else if (family === 'auto') {
    // Signature swash over a dark panel.
    body.push(`<rect x="4" y="4" width="242" height="342" rx="7" fill="url(#${ID.grad})"/>`,
      `<path d="M38 246 C 74 196, 96 288, 130 232 S 176 178, 214 236"
        fill="none" stroke="#ffffff" stroke-opacity="0.5" stroke-width="3.2"
        stroke-linecap="round"/>`,
      `<path d="M52 262 C 96 240, 150 268, 206 246" fill="none" stroke="#ffffff"
        stroke-opacity="0.22" stroke-width="1.6" stroke-linecap="round"/>`);
  } else if (family === 'insert') {
    body.push(`<rect x="4" y="4" width="242" height="342" rx="7" fill="url(#${ID.grad})"/>`,
      `<circle cx="125" cy="150" r="118" fill="${shift(main, 40)}" fill-opacity="0.20"/>`,
      `<circle cx="125" cy="150" r="72" fill="${shift(main, 55)}" fill-opacity="0.18"/>`);
  } else {
    body.push(`<rect x="4" y="4" width="242" height="342" rx="7" fill="url(#${ID.grad})"/>`);
  }

  // ---- the player, if we have a portrait; otherwise their monogram --------
  if (portrait) {
    // The portrait sits in an inset window, not full-bleed. A real card frames the
    // photograph inside the set's design, and full-bleed lost exactly the signal the
    // family artwork exists to carry — a Kaboom starburst and Optic refractor bands
    // both vanished behind the face, making every version look identical again.
    const win = { x: 21, y: 30, w: 208, h: 196 };
    body.push(
      `<clipPath id="${ID.face}"><rect x="${win.x}" y="${win.y}" width="${win.w}" height="${win.h}" rx="5"/></clipPath>`,
      `<rect x="${win.x - 2}" y="${win.y - 2}" width="${win.w + 4}" height="${win.h + 4}" rx="7"
             fill="#141413" fill-opacity="0.55"/>`,
      `<g clip-path="url(#${ID.face})">
         <image href="${portrait}" x="${win.x}" y="${win.y}" width="${win.w}" height="${win.h}"
                preserveAspectRatio="xMidYMin slice"/>
         <rect x="${win.x}" y="${win.y + win.h - 46}" width="${win.w}" height="46"
               fill="url(#${ID.fade})"/>
       </g>`,
      `<rect x="${win.x}" y="${win.y}" width="${win.w}" height="${win.h}" rx="5" fill="none"
             stroke="#ffffff" stroke-opacity="0.30" stroke-width="1"/>`,
      // Monogram moves below the window so the player is still named on the art.
      `<text x="125" y="272" text-anchor="middle"
         font-family="system-ui,-apple-system,'Segoe UI',sans-serif" font-size="34"
         font-weight="700" fill="#ffffff" fill-opacity="0.30">${esc(initials)}</text>`,
    );
  } else {
    body.push(`<text x="125" y="196" text-anchor="middle"
      font-family="system-ui,-apple-system,'Segoe UI',sans-serif" font-size="88"
      font-weight="700" fill="#ffffff" fill-opacity="${family === 'kaboom' ? 0.30 : 0.19}"
      >${esc(initials)}</text>`);
  }

  // ---- numbered parallel: foil band + the print run --------------------
  if (run != null) {
    body.push(`<rect x="4" y="292" width="242" height="54" fill="#000000" fill-opacity="0.42"/>`,
      `<rect x="4" y="292" width="242" height="2" fill="${shift(main, 70)}" fill-opacity="0.9"/>`,
      `<text x="125" y="330" text-anchor="middle"
        font-family="system-ui,-apple-system,'Segoe UI',sans-serif" font-size="26"
        font-weight="700" letter-spacing="1" fill="#ffffff" fill-opacity="0.88"
        >${run === 1 ? '1 of 1' : '/' + run}</text>`);
  }

  // ---- graded: draw the slab, not the card ------------------------------
  const shell = graded
    ? `<rect x="0" y="0" width="250" height="350" rx="10" fill="#e9e7e0"/>
       <rect x="10" y="46" width="230" height="292" rx="4" fill="#1a1a19"/>
       <text x="20" y="26" font-family="system-ui,sans-serif" font-size="15" font-weight="800"
             fill="#111">${esc(c.grader ?? '')}</text>
       <text x="230" y="27" text-anchor="end" font-family="system-ui,sans-serif" font-size="19"
             font-weight="800" fill="#111">${c.grade ?? '?'}</text>
       <text x="20" y="39" font-family="system-ui,sans-serif" font-size="7" letter-spacing="1.1"
             fill="#555">${esc((c.player ?? '').toUpperCase().slice(0, 26))}</text>`
    : `<rect width="250" height="350" fill="#1a1a19"/>`;

  // Graded cards render the artwork inset inside the slab window.
  const inner = graded
    ? `<g transform="translate(10,46) scale(0.92,0.834)">${body.join('')}</g>`
    : body.join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 250 350" width="250" height="350"
     role="img" aria-label="${esc(c.player ?? '')} ${esc(section)} #${esc(c.card_number ?? '')}${
       c.parallel_name ? ' ' + esc(c.parallel_name) : ''}${graded ? ` ${esc(c.grader!)} ${c.grade}` : ''} (generated artwork, no photograph yet)">
  <defs>
    <clipPath id="${ID.clip}"><rect x="4" y="4" width="242" height="342" rx="7"/></clipPath>
    <linearGradient id="${ID.grad}" x1="0" y1="0" x2="0.55" y2="1">
      <stop offset="0%" stop-color="${main}" stop-opacity="0.95"/>
      <stop offset="52%" stop-color="${main}" stop-opacity="0.42"/>
      <stop offset="100%" stop-color="#141413" stop-opacity="0.97"/>
    </linearGradient>
    <linearGradient id="${ID.fade}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#141413" stop-opacity="0"/>
      <stop offset="100%" stop-color="#141413" stop-opacity="0.85"/>
    </linearGradient>
    <linearGradient id="${ID.sheen}" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="0.17"/>
      <stop offset="44%" stop-color="#ffffff" stop-opacity="0.02"/>
      <stop offset="100%" stop-color="#ffffff" stop-opacity="0.10"/>
    </linearGradient>
  </defs>
  ${shell}
  ${inner}
  <rect x="4" y="4" width="242" height="342" rx="7" fill="url(#${ID.sheen})" ${graded ? 'opacity="0"' : ''}/>
  <rect x="4.5" y="4.5" width="241" height="341" rx="7" fill="none"
        stroke="#ffffff" stroke-opacity="${graded ? 0 : 0.14}" stroke-width="1"/>
</svg>`;
}

/**
 * Colour words in a parallel name drive the artwork's hue, so a Gold /10 and a
 * Teal /199 of the same card are immediately distinguishable in a grid.
 */
const PARALLEL_HUES: Array<[RegExp, string]> = [
  [/black/i, '#3a3a38'], [/gold/i, '#c98500'], [/silver|holo/i, '#9aa4ad'],
  [/bronze/i, '#a2643a'], [/purple|violet/i, '#9085e9'], [/pink|magenta/i, '#d55181'],
  [/teal|aqua/i, '#199e70'], [/green|lime/i, '#008300'], [/blue|cyan/i, '#3987e5'],
  [/red|crimson/i, '#d03b3b'], [/orange/i, '#d95926'], [/white|snow/i, '#c3c2b7'],
  [/diamond|crystal|ice/i, '#86b6ef'], [/nebula|galaxy|cosmic/i, '#7a5cd0'],
  [/argyle/i, '#5598e7'], [/laser|prizm|refractor|maze|swirl|cubic/i, '#2a78d6'],
];

function parallelHue(name: string): string | null {
  for (const [re, hex] of PARALLEL_HUES) if (re.test(name)) return hex;
  return null;
}

/** Nudge a hex colour lighter (positive) or darker (negative). */
function shift(hex: string, amount: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1]!, 16);
  const cl = (v: number) => Math.max(0, Math.min(255, v));
  const r = cl(((n >> 16) & 255) + amount);
  const g = cl(((n >> 8) & 255) + amount);
  const b = cl((n & 255) + amount);
  return '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
}


/**
 * A player avatar: the portrait if we have one, otherwise a monogram disc.
 *
 * Separate from the card art on purpose — the player-first gallery asks "who is
 * this?", which wants a face on a neutral field, not a Kaboom starburst.
 */
export interface NationKit {
  primary_hex: string;
  secondary_hex: string;
  pattern: string;      // 'solid' | 'stripes' | 'checks' | 'halves'
  verified?: boolean;
}

export function avatarSvg(a: {
  player: string;
  team?: string | null;
  portraitDataUri?: string | null;
  kit?: NationKit | null;
  /** Playing position, if known. Selects the pose; unknown draws the neutral figure. */
  position?: string | null;
  /** A pinned pose, which outranks the position mapping. */
  pose?: PoseName | string | null;
  /** Marquee treatment: rays, warm rim, larger figure. Set for icons and hot cards. */
  iconic?: boolean;
  /** Idle motion. On by default; the browser's reduced-motion setting still wins. */
  animate?: boolean;
}): string {
  const pose = resolvePose(a.pose, a.position);
  // Staging varies per player so two players in the same kit and position do not render
  // identically. Nothing here invents an attribute of a real person — see avatarStyle.ts.
  const style = avatarStyle(a.player, { iconic: a.iconic === true });
  const uid = 'v' + createHash('sha1')
    .update(a.player + (a.portraitDataUri ? 'p' : 'm') + pose).digest('hex').slice(0, 8);

  if (a.portraitDataUri) {
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 300" width="300" height="300"
       role="img" aria-label="${esc(a.player)}">
  <defs>
    <clipPath id="c${uid}"><rect width="300" height="300" rx="10"/></clipPath>
    <linearGradient id="d${uid}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#141413" stop-opacity="0"/>
      <stop offset="70%" stop-color="#141413" stop-opacity="0.55"/>
      <stop offset="100%" stop-color="#141413" stop-opacity="0.88"/>
    </linearGradient>
  </defs>
  <rect width="300" height="300" rx="10" fill="#232321"/>
  <g clip-path="url(#c${uid})">
    <image href="${a.portraitDataUri}" x="0" y="0" width="300" height="300"
           preserveAspectRatio="xMidYMin slice"/>
    <rect y="130" width="300" height="170" fill="url(#d${uid})"/>
  </g>
</svg>`;
  }

  // No portrait yet: a head-and-shoulders silhouette on the player's national kit.
  //
  // A grid of initials reads as unfinished — as though the data failed to load. A
  // silhouette on the right kit colours reads as deliberate, tells nations apart at a
  // glance (Argentina's stripes, Croatia's checks, the Netherlands' orange), costs
  // about a kilobyte, needs no image model and raises no rights question. Real
  // portraits replace it as they arrive.
  const kit = a.kit ?? null;
  let field: string;
  let ink: string;

  if (kit) {
    const p = kit.primary_hex, q2 = kit.secondary_hex;
    // Silhouette ink is whichever kit colour stays visible against the field.
    ink = contrastRatio(q2, p) >= 1.9 ? q2 : (isLight(p) ? '#141413' : '#ffffff');
    if (kit.pattern === 'stripes') {
      const bars = Array.from({ length: 10 }, (_, i) =>
        `<rect x="${i * 30}" y="0" width="15" height="300" fill="${q2}" fill-opacity="0.9"/>`).join('');
      field = `<rect width="300" height="300" fill="${p}"/>${bars}`;
    } else if (kit.pattern === 'checks') {
      const sq: string[] = [];
      for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
        if ((r + c) % 2 === 0) continue;
        sq.push(`<rect x="${c * 37.5}" y="${r * 37.5}" width="37.5" height="37.5" fill="${q2}" fill-opacity="0.92"/>`);
      }
      field = `<rect width="300" height="300" fill="${p}"/>${sq.join('')}`;
    } else if (kit.pattern === 'halves') {
      field = `<rect width="150" height="300" fill="${p}"/><rect x="150" width="150" height="300" fill="${q2}"/>`;
    } else {
      field = `<rect width="300" height="300" fill="${p}"/>`;
    }
  } else {
    // No kit on file: a neutral tint from the name rather than a guessed colour.
    const TINTS = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'];
    const tint = TINTS[parseInt(createHash('sha1').update(a.player).digest('hex').slice(0, 2), 16) % 8]!;
    field = `<rect width="300" height="300" fill="${shift(tint, -60)}"/>`;
    ink = '#ffffff';
  }

  // A striped or chequered kit swallows a flat silhouette, so give the figure an
  // outline in the opposite tone — it then reads over any pattern instead of only
  // over solid colours. Croatia and Paraguay were the cases that exposed this.
  const rim = isLight(ink) ? '#141413' : '#ffffff';

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 300" width="300" height="300"
     role="img" aria-label="${esc(a.player)}${a.team ? ', ' + esc(a.team) : ''} — no photograph available">
  ${a.animate === false ? '' : motionCss(pose, style, uid)}
  <defs>
    <clipPath id="k${uid}"><rect width="300" height="300" rx="10"/></clipPath>
    <linearGradient id="v${uid}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#141413" stop-opacity="0"/>
      <stop offset="72%" stop-color="#141413" stop-opacity="0.30"/>
      <stop offset="100%" stop-color="#141413" stop-opacity="0.72"/>
    </linearGradient>
  </defs>
  <g clip-path="url(#k${uid})">
    ${field}
    ${backdropSvg(style, uid)}
    <g class="fg${uid}" transform="translate(${style.mirror ? 300 : 0} ${style.offsetY})
        scale(${style.mirror ? -style.scale : style.scale} ${style.scale})
        translate(${style.mirror ? 0 : (150 * (1 - style.scale)) / style.scale} 0)">
      ${figureSvg(pose, ink, rim)}
    </g>
    ${style.iconic ? `<rect x="1.5" y="1.5" width="297" height="297" rx="9" fill="none"
        stroke="#ffe9b0" stroke-opacity="0.5" stroke-width="3"/>` : ''}
    <rect y="150" width="300" height="150" fill="url(#v${uid})"/>
  </g>
</svg>`;
}


/**
 * Which pose to draw: a pinned pose first, then the position mapping, then neutral.
 *
 * An unrecognised pinned value falls through to the position rather than throwing —
 * a bad string in one row should not 500 the whole gallery.
 */
export function resolvePose(pinned?: string | null, position?: string | null): PoseName {
  const p = (pinned ?? '').trim().toLowerCase();
  if (p && POSE_SET.has(p)) return p as PoseName;
  return poseForPosition(position);
}
const POSE_SET = new Set<string>([
  'standing', 'walking', 'running', 'striking', 'celebrating', 'sliding', 'diving', 'heading',
]);

/** Relative luminance, for deciding whether ink should be dark or light. */
function luminance(hex: string): number {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return 0.5;
  const n = parseInt(m[1]!, 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * ch[0]! + 0.7152 * ch[1]! + 0.0722 * ch[2]!;
}

export function isLight(hex: string): boolean { return luminance(hex) > 0.42; }

export function contrastRatio(a: string, b: string): number {
  const la = luminance(a), lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
