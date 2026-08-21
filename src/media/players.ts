import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cfg } from '../config.js';
import { q, one } from '../db.js';
import { log } from '../logger.js';

/**
 * Player portraits from Wikidata + Wikimedia Commons.
 *
 * Why this source: it is free, needs no key, covers essentially every player in a
 * World Cup product, and — crucially — carries machine-readable licensing. Scraping
 * portraits off a news site would be faster to write and would hand you images you
 * have no right to display.
 *
 * The licensing is the part to take seriously. Commons is overwhelmingly CC BY and
 * CC BY-SA, both of which REQUIRE attribution: author, licence, and a link back.
 * So every stored portrait carries all three, anything whose licence can't be
 * established is refused, and the UI shows the credit wherever the portrait appears.
 * A tracker that silently strips attribution is handing its user a legal problem.
 */

/**
 * Wikimedia's User-Agent policy asks for a descriptive agent WITH a way to contact the
 * operator, and requests that look generic get refused rather than throttled. The first
 * version sent a bare product string and 191 of 200 lookups came back as errors.
 *
 * Set WIKIMEDIA_CONTACT to an email or a URL you control. It is sent to Wikimedia only.
 */
const CONTACT = process.env.WIKIMEDIA_CONTACT?.trim();
const UA = process.env.WIKIMEDIA_USER_AGENT?.trim()
  || `CardVault/1.0 (personal trading-card collection tracker; `
     + `${CONTACT || 'https://github.com/cardvault; set WIKIMEDIA_CONTACT'}) node-fetch`;
const WIKIDATA = 'https://www.wikidata.org/w/api.php';
const COMMONS = 'https://commons.wikimedia.org/w/api.php';

/** Wikidata: occupation (P106) = association football player. */
const Q_FOOTBALLER = 'Q937857';
/** Also accept the broader "footballer"/"athlete" senses some entries use. */
const Q_OCCUPATION_OK = new Set([Q_FOOTBALLER, 'Q2066131' /* athlete */, 'Q628099' /* association football manager */]);
const P_OCCUPATION = 'P106';
const P_IMAGE = 'P18';
/** Wikidata: position played on team / speciality. Picks the avatar pose. */
const P_POSITION = 'P413';
/** Wikidata: member of sports team. Their club, if one is current. */
const P_TEAM = 'P54';

/** Licences we will display. Anything else is refused. */
const LICENSE_OK = /^(cc[ -]?by([ -]sa)?([ -]?\d(\.\d)?)?|cc0|public domain|pd[ -]|no restrictions)/i;
const LICENSE_BAD = /fair use|non[- ]free|all rights reserved|copyright/i;

export interface PortraitResult {
  /** `throttled` is transient: the row stays pending so the next run retries it. */
  status: 'ok' | 'not_found' | 'no_image' | 'license_unclear' | 'error' | 'throttled';
  wikidataId?: string;
  label?: string;
  thumbUrl?: string;
  fullUrl?: string;
  license?: string;
  licenseUrl?: string;
  author?: string;
  creditUrl?: string;
  width?: number;
  note?: string;
  /** P413 label, e.g. "goalkeeper", "centre-back". Absent when the entry has none. */
  position?: string;
  /** Current club from P54, if exactly one statement is current. */
  club?: string;
  /** Why we believe the club — or why we don't. */
  clubResolution?: ClubResolution;
  /** The Wikidata entity revision this was read from. */
  revision?: number;
}

/**
 * Every Wikimedia request in this file goes through one adaptive rate limiter.
 *
 * The first real backfill returned 429 for 216 of 225 players. The reason was arithmetic
 * I never did: the delay was per *player*, but each player costs up to five requests —
 * search, entity, labels, Commons imageinfo, then the image download itself. A 700ms
 * player delay is therefore about seven requests per second at Wikimedia, sustained for
 * minutes. Individually every lookup worked; in bulk they were all refused.
 *
 * So the spacing belongs between REQUESTS, not between players, and it has to react:
 * a 429 means the current pace is wrong, not that this player has no photograph.
 */
const MIN_INTERVAL_MS = Number(process.env.WIKIMEDIA_MIN_INTERVAL_MS) || 1100;
const MAX_INTERVAL_MS = 12_000;

class Pace {
  private interval = MIN_INTERVAL_MS;
  private next = 0;
  /** Set when a 429 is seen, so callers can report it rather than guess. */
  throttled = 0;

  async wait(): Promise<void> {
    const now = Date.now();
    const at = Math.max(now, this.next);
    this.next = at + this.interval;
    if (at > now) await sleep(at - now);
  }

  /** A refusal means back off hard; recovery is deliberately slow. */
  slowDown(retryAfterSec?: number): number {
    this.throttled++;
    this.interval = Math.min(MAX_INTERVAL_MS, Math.round(this.interval * 2));
    const pause = Math.min(60, Math.max(retryAfterSec ?? 5, 5));
    this.next = Date.now() + pause * 1000;
    return pause;
  }

  /** Creep back toward the base pace, 5% at a time, so one 429 is not permanent. */
  speedUp(): void {
    if (this.interval > MIN_INTERVAL_MS) {
      this.interval = Math.max(MIN_INTERVAL_MS, Math.round(this.interval * 0.95));
    }
  }

  get intervalMs(): number { return this.interval; }
}

const pace = new Pace();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Thrown for refusals that mean "later" — the row stays pending, not errored. */
export class TransientError extends Error {
  constructor(message: string) { super(message); this.name = 'TransientError'; }
}

/**
 * One Wikimedia API call, paced and retried.
 *
 * `origin=*` is gone: it is a browser CORS switch, and from a server it only forces the
 * request into anonymous mode.
 */
async function api(url: string, params: Record<string, string>, attempt = 0): Promise<any> {
  await pace.wait();
  const qs = new URLSearchParams({ format: 'json', ...params });
  const res = await fetch(`${url}?${qs}`, {
    headers: { 'User-Agent': UA, Accept: 'application/json' },
    signal: AbortSignal.timeout(20_000),
  });

  if (res.status === 429 || res.status >= 500) {
    const after = Number(res.headers.get('retry-after')) || undefined;
    const paused = pace.slowDown(after);
    if (attempt < 3) {
      log.debug({ status: res.status, pausedSec: paused, intervalMs: pace.intervalMs },
                'wikimedia asked us to slow down');
      return api(url, params, attempt + 1);
    }
    throw new TransientError(
      `${res.status} ${res.statusText} after ${attempt + 1} attempts — `
      + `pace is now ${pace.intervalMs}ms between requests`);
  }
  if (!res.ok) {
    // The body carries Wikimedia's own explanation, and it is the difference between
    // "403" and "403: your user agent is on the blocked list".
    const body = await res.text().catch(() => '');
    const hint = body.slice(0, 200).replace(/\s+/g, ' ').trim();
    throw new Error(`${res.status} ${res.statusText}${hint ? ` — ${hint}` : ''} [${new URL(url).host}]`);
  }
  pace.speedUp();
  return res.json();
}

/** Requests made outside `api()` — currently just the image download — pace too. */
export function pacing() { return { intervalMs: pace.intervalMs, throttled: pace.throttled }; }

/** Strip Commons' HTML-wrapped metadata values down to text. */
export function cleanMeta(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const text = v
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
  return text || null;
}

/** First href in an HTML metadata blob — Commons puts the author's user page there. */
export function firstHref(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const m = /href="([^"]+)"/i.exec(v);
  if (!m) return null;
  const href = m[1]!;
  return href.startsWith('//') ? 'https:' + href : href;
}

/**
 * Decide whether a Commons licence is safe to display, and normalise it.
 * Refuses rather than guesses: an unclear licence is treated as unusable.
 */
export function evaluateLicense(shortName: unknown, rawLicense: unknown): { ok: boolean; label: string | null } {
  const label = cleanMeta(shortName) ?? cleanMeta(rawLicense);
  if (!label) return { ok: false, label: null };
  if (LICENSE_BAD.test(label) && !LICENSE_OK.test(label)) return { ok: false, label };
  if (!LICENSE_OK.test(label)) return { ok: false, label };
  return { ok: true, label };
}

/**
 * Pick the Wikidata entity that is actually a footballer.
 *
 * Without this check, "Danny Welbeck" style name collisions resolve to a musician
 * or a politician and you end up with a confidently wrong face on the card. The
 * occupation claim is the cheapest reliable discriminator.
 */
export function pickFootballer(
  entities: Record<string, any>,
  order: string[],
): { id: string; label?: string } | null {
  for (const id of order) {
    const e = entities?.[id];
    if (!e) continue;
    const claims = e.claims ?? {};
    const occupations: string[] = (claims[P_OCCUPATION] ?? [])
      .map((c: any) => c?.mainsnak?.datavalue?.value?.id)
      .filter(Boolean);
    if (occupations.some((o) => Q_OCCUPATION_OK.has(o))) {
      return { id, label: e.labels?.en?.value };
    }
  }
  return null;
}

export function imageFilenameFromEntity(entity: any): string | null {
  const claim = (entity?.claims?.[P_IMAGE] ?? [])[0];
  const name = claim?.mainsnak?.datavalue?.value;
  return typeof name === 'string' && name.length ? name : null;
}

/**
 * The P413 item ids on an entity, in claim order.
 *
 * Exported for tests: the ordering matters, because a player with both "midfielder"
 * and "winger" should render as the first-listed, not an arbitrary one.
 */
export function positionIdsFromEntity(entity: any): string[] {
  const claims = entity?.claims?.[P_POSITION] ?? [];
  return claims
    .map((c: any) => c?.mainsnak?.datavalue?.value?.id)
    .filter((id: any) => typeof id === 'string');
}

/**
 * The current club's item id from P54, or null.
 *
 * P54 is a career history, not a field: a 34-year-old has a dozen statements. The
 * current one is the statement with **no end date** (P582). Taking the first, or the
 * last, or the highest-ranked gives you a club the player left in 2019 — and a club
 * filter that quietly shows old squads is worse than one that says it doesn't know.
 *
 * If more than one statement is open-ended (loans overlap, and Wikidata is often
 * mid-edit), this returns null rather than picking. Exported for tests.
 */
export type ClubResolution = 'single-current' | 'ambiguous' | 'unknown' | 'manual';

export function resolveTeam(entity: any): { id: string | null; resolution: ClubResolution } {
  const claims: any[] = entity?.claims?.[P_TEAM] ?? [];
  if (!claims.length) return { id: null, resolution: 'unknown' };

  const open = claims.filter((c) => {
    if (c?.rank === 'deprecated') return false;
    const ended = (c?.qualifiers?.P582 ?? []).some((q: any) => q?.datavalue != null);
    return !ended && typeof c?.mainsnak?.datavalue?.value?.id === 'string';
  });
  if (!open.length) return { id: null, resolution: 'unknown' };

  // A preferred open statement wins over a merely normal one — that is exactly what
  // rank is for, and it resolves most overlapping-loan cases on its own.
  const preferred = open.filter((c) => c.rank === 'preferred');
  const pick = preferred.length === 1 ? preferred : open;
  if (pick.length !== 1) return { id: null, resolution: 'ambiguous' };
  return { id: pick[0].mainsnak.datavalue.value.id, resolution: 'single-current' };
}

/** Back-compat shape: the id only. */
export function currentTeamId(entity: any): string | null {
  return resolveTeam(entity).id;
}

/**
 * Resolve P413 to a plain-English position.
 *
 * Matched on the item's **label**, not on a hardcoded QID table. Position QIDs are
 * easy to get subtly wrong from memory, and a wrong id silently means "no position"
 * — or worse, the wrong one. A label round-trip costs one extra API call and is
 * checkable by eye.
 */
export async function positionFor(entity: any): Promise<string | undefined> {
  const r = await labelsFor(entity);
  return r.position;
}

/**
 * One label round-trip for both position and club.
 *
 * Both are item references, so resolving them together costs one request instead of
 * two — and the backfill runs 783 times.
 */
export async function labelsFor(entity: any): Promise<{
  position?: string; club?: string; clubResolution: ClubResolution;
}> {
  const posIds = positionIdsFromEntity(entity).slice(0, 4);
  const team = resolveTeam(entity);
  const clubId = team.id;
  const ids = [...posIds, ...(clubId ? [clubId] : [])];
  if (!ids.length) return { clubResolution: team.resolution };

  const res = await api(WIKIDATA, {
    action: 'wbgetentities', ids: ids.join('|'), props: 'labels', languages: 'en',
  });
  const label = (id: string | null) => {
    if (!id) return undefined;
    const v = res?.entities?.[id]?.labels?.en?.value;
    return typeof v === 'string' && v.trim() ? v.trim() : undefined;
  };
  let position: string | undefined;
  for (const id of posIds) {
    const v = label(id);
    if (v) { position = v.toLowerCase(); break; }
  }
  return { position, club: label(clubId), clubResolution: team.resolution };
}

/** Parse a Commons `imageinfo` response into an attributed portrait. */
export function parseCommonsImageinfo(json: any): Omit<PortraitResult, 'status'> & { ok: boolean; reason?: string } {
  const pages = json?.query?.pages ?? {};
  const page: any = Object.values(pages)[0];
  const info = page?.imageinfo?.[0];
  if (!info) return { ok: false, reason: 'no imageinfo returned' };

  const meta = info.extmetadata ?? {};
  const lic = evaluateLicense(meta.LicenseShortName?.value, meta.License?.value);
  if (!lic.ok) {
    return { ok: false, reason: `licence not usable: ${lic.label ?? 'unknown'}` };
  }

  return {
    ok: true,
    thumbUrl: info.thumburl ?? info.url,
    fullUrl: info.url,
    width: info.thumbwidth ?? info.width,
    license: lic.label ?? undefined,
    licenseUrl: cleanMeta(meta.LicenseUrl?.value) ?? undefined,
    author: cleanMeta(meta.Artist?.value) ?? 'Unknown',
    creditUrl: info.descriptionurl ?? firstHref(meta.Artist?.value) ?? undefined,
  };
}

/**
 * Look up one player's portrait. Three calls: search, entity (occupation + image),
 * then Commons for the thumbnail and licence.
 */
export async function lookupPortrait(name: string, thumbWidth = 320): Promise<PortraitResult> {
  try {
    const search = await api(WIKIDATA, {
      action: 'wbsearchentities', search: name, language: 'en', uselang: 'en',
      type: 'item', limit: '5',
    });
    const ids: string[] = (search?.search ?? []).map((s: any) => s.id).filter(Boolean);
    if (!ids.length) return { status: 'not_found', note: 'no Wikidata entity matched the name' };

    const ent = await api(WIKIDATA, {
      action: 'wbgetentities', ids: ids.join('|'), props: 'claims|labels', languages: 'en',
    });
    const chosen = pickFootballer(ent?.entities ?? {}, ids);
    if (!chosen) {
      return { status: 'not_found', note: 'entities matched the name but none is a footballer' };
    }

    // Position and club are nice-to-haves, never a reason to fail the lookup: the
    // portrait is the point, a missing pose falls back to the neutral figure, and an
    // unknown club groups under "Club unknown".
    const { position, club, clubResolution } =
      await labelsFor(ent.entities[chosen.id]).catch(() => ({}) as any);
    // The revision we actually read. `checked_at` says when we looked; this says what
    // we looked at, which is the question you have when a club turns out wrong.
    const revision: number | undefined = ent.entities[chosen.id]?.lastrevid;

    const filename = imageFilenameFromEntity(ent.entities[chosen.id]);
    if (!filename) {
      return { status: 'no_image', wikidataId: chosen.id, label: chosen.label, position, club, clubResolution, revision,
               note: 'Wikidata entry has no image (P18)' };
    }

    const ci = await api(COMMONS, {
      action: 'query', prop: 'imageinfo', titles: `File:${filename}`,
      iiprop: 'url|extmetadata|size', iiurlwidth: String(thumbWidth),
    });
    const parsed = parseCommonsImageinfo(ci);
    if (!parsed.ok) {
      return { status: 'license_unclear', wikidataId: chosen.id, label: chosen.label,
               position, club, clubResolution, revision, note: parsed.reason };
    }

    return { status: 'ok', wikidataId: chosen.id, label: chosen.label, position, club,
             clubResolution, revision, ...parsed };
  } catch (e: any) {
    // A 429 is not "this player has no photograph". Marking it 'error' meant the next
    // run skipped 216 players who were never actually looked up.
    if (e instanceof TransientError) return { status: 'throttled', note: e.message } as any;
    return { status: 'error', note: e.message };
  }
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

const dir = () => join(cfg.IMAGE_CACHE_DIR, 'portraits');

async function cacheBytes(name: string, url: string): Promise<{ path: string; mime: string; reason?: string } | null> {
  // Returns the reason on failure rather than a bare null. The first version swallowed
  // every download failure into `lookup_status = 'error'` with the note "thumbnail
  // download failed", which is true and useless: it could equally be a 403 on the user
  // agent, an unwritable cache directory, or DNS.
  try {
    await pace.wait();
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'image/*' },
      signal: AbortSignal.timeout(25_000),
    });
    if (res.status === 429 || res.status >= 500) {
      const paused = pace.slowDown(Number(res.headers.get('retry-after')) || undefined);
      return { path: '', mime: '',
               reason: `image fetch ${res.status}; backed off ${paused}s` } as any;
    }
    if (!res.ok) {
      log.debug({ name, status: res.status }, 'portrait download rejected');
      return { path: '', mime: '', reason: `image fetch ${res.status} ${res.statusText} [${new URL(url).host}]` } as any;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 512) {
      return { path: '', mime: '', reason: `image was ${buf.length} bytes, treated as an error page` } as any;
    }
    const mime = res.headers.get('content-type')?.split(';')[0] ?? 'image/jpeg';
    const ext = mime.includes('png') ? 'png' : mime.includes('webp') ? 'webp' : 'jpg';
    await mkdir(dir(), { recursive: true });
    const path = join(dir(), `${createHash('sha1').update(name).digest('hex').slice(0, 12)}.${ext}`);
    await writeFile(path, buf);
    return { path, mime };
  } catch (e: any) {
    log.debug({ name, err: e.message }, 'portrait download failed');
    return { path: '', mime: '', reason: `image fetch failed: ${e.message}` } as any;
  }
}

export async function resolvePlayer(name: string): Promise<PortraitResult> {
  let r = await lookupPortrait(name);

  let path: string | null = null;
  let mime: string | null = null;
  if (r.status === 'ok' && r.thumbUrl) {
    const cached = await cacheBytes(name, r.thumbUrl);
    if (cached?.path) { path = cached.path; mime = cached.mime; }
    // Carry the download's reason into the row, so --status stops being a dead end.
    else if (cached?.reason) r = { ...r, note: cached.reason };
  }

  await q(
    `UPDATE players SET
       wikidata_id = $2, wikidata_label = $3,
       portrait_url = $4, portrait_full_url = $5, portrait_path = $6, portrait_mime = $7,
       portrait_width = $8, license = $9, license_url = $10, author = $11, credit_url = $12,
       attribution_required = $13,
       lookup_status = $14, lookup_note = $15, attempts = players.attempts + 1, fetched_at = now(),
       -- A hand-set position outranks Wikidata; a seeded one does not.
       position = CASE WHEN $16::text IS NULL THEN players.position
                       WHEN players.position_source = 'manual' THEN players.position
                       ELSE $16 END,
       position_source = CASE WHEN $16::text IS NULL THEN players.position_source
                              WHEN players.position_source = 'manual' THEN 'manual'
                              ELSE 'wikidata' END,
       -- A hand-set club is never overwritten, but we still record that we looked.
       club = CASE WHEN players.club_source = 'manual' THEN players.club
                   WHEN $17::text IS NULL THEN players.club
                   ELSE $17 END,
       club_source = CASE WHEN players.club_source = 'manual' THEN 'manual'
                          WHEN $17::text IS NULL THEN players.club_source
                          ELSE 'wikidata' END,
       club_resolution = CASE WHEN players.club_source = 'manual' THEN 'manual'
                              ELSE COALESCE($18::text, players.club_resolution) END,
       club_checked_at = CASE WHEN $18::text IS NULL THEN players.club_checked_at ELSE now() END,
       club_revision   = COALESCE($19::bigint, players.club_revision)
     WHERE name = $1`,
    [name, r.wikidataId ?? null, r.label ?? null,
     r.thumbUrl ?? null, r.fullUrl ?? null, path, mime, r.width ?? null,
     r.license ?? null, r.licenseUrl ?? null, r.author ?? null, r.creditUrl ?? null,
     !/^(cc0|public domain|pd)/i.test(r.license ?? ''),
     // 'throttled' is stored as 'pending' on purpose: the player was never actually
     // looked up, so the next run must pick them up again without needing --retry.
     path ? 'ok' : r.status === 'throttled' ? 'pending' : (r.status === 'ok' ? 'error' : r.status),
     path ? null : (r.note ?? 'thumbnail download failed'),
     r.position ?? null, r.club ?? null, r.clubResolution ?? null, r.revision ?? null],
  );
  return r;
}

/**
 * Backfill portraits, newest-value-first so the cards you care about get faces
 * before the commons do. Rate-limited out of basic courtesy to a free service.
 */
export async function backfillPortraits(opts: { limit?: number; delayMs?: number; retryErrors?: boolean } = {}) {
  // Self-heal rows an older build recorded wrongly. A 429 was written as `error`, which
  // the query below skips - so 216 players who were never actually looked up would have
  // stayed unfetched forever. Matching on the recorded reason means a genuine failure is
  // never swept back into the queue.
  const reclaimed = await q(
    `UPDATE players
        SET lookup_status = 'pending', lookup_note = NULL, attempts = 0
      WHERE lookup_status = 'error'
        AND (lookup_note LIKE '429%' OR lookup_note ILIKE '%too many requests%')
      RETURNING 1`);
  if (reclaimed.length) {
    log.info({ reclaimed: reclaimed.length }, 'rate-limited rows returned to the queue');
  }

  const limit = opts.limit ?? 60;
  // Spacing lives in the request pacer now, not here: the old 700ms was per player, and
  // a player costs up to five requests.
  const delay = opts.delayMs ?? 0;

  const rows = await q<{ name: string }>(
    `SELECT p.name
       FROM players p
       LEFT JOIN (
         SELECT c.player, MAX(COALESCE(v.fair_value_aud, c.seed_est_aud, 0)) AS val,
                BOOL_OR(h.sku_id IS NOT NULL) AS held
           FROM cards c
           JOIN skus s ON s.card_id = c.id
           LEFT JOIN latest_valuation v ON v.sku_id = s.id AND v.marketplace_code IS NULL
           LEFT JOIN holdings h ON h.sku_id = s.id AND h.qty > 0
          GROUP BY c.player
       ) x ON x.player = p.name
      WHERE p.lookup_status = 'pending'
         OR ($1 AND p.lookup_status = 'error' AND p.attempts < 3)
      ORDER BY x.held DESC NULLS LAST, x.val DESC NULLS LAST
      LIMIT $2`,
    [!!opts.retryErrors, limit],
  );

  const counts: Record<string, number> = {};
  let consecutiveThrottles = 0;

  for (const { name } of rows) {
    const r = await resolvePlayer(name);
    counts[r.status] = (counts[r.status] ?? 0) + 1;

    if (r.status === 'throttled') {
      consecutiveThrottles++;
      // Hammering a service that is already refusing is both rude and pointless. Stop
      // and report; the rows stay pending, so resuming costs nothing.
      if (consecutiveThrottles >= 5) {
        log.warn({ done: Object.values(counts).reduce((a, b) => a + b, 0) },
                 'stopping early: Wikimedia is rate-limiting us. Rerun later to resume.');
        break;
      }
    } else {
      consecutiveThrottles = 0;
    }
    // The pacer already spaces requests; this is just extra courtesy between players.
    if (delay > 0) await new Promise((res) => setTimeout(res, delay));
  }

  const done = Object.values(counts).reduce((a, b) => a + b, 0);
  log.info({ attempted: done, of: rows.length, ...counts, paceMs: pacing().intervalMs },
           'portrait backfill complete');
  return { attempted: done, of: rows.length, ...counts, paceMs: pacing().intervalMs };
}

/** Pin a portrait by hand — your own crop, or a file you have the right to use. */
export async function setPortraitManually(name: string, dataUrl: string, credit: {
  author?: string; license?: string; licenseUrl?: string; creditUrl?: string;
} = {}) {
  const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(dataUrl.trim());
  const b64 = (m ? m[3]! : dataUrl).replace(/\s+/g, '');
  const buf = Buffer.from(b64, 'base64');
  if (buf.length < 512) throw new Error('image too small or unreadable');
  if (buf.length > 8 * 1024 * 1024) throw new Error('image over the 8 MB limit');

  const mime = m?.[1] ?? 'image/jpeg';
  const ext = mime.includes('png') ? 'png' : mime.includes('webp') ? 'webp' : 'jpg';
  await mkdir(dir(), { recursive: true });
  const path = join(dir(), `manual-${createHash('sha1').update(name).digest('hex').slice(0, 12)}.${ext}`);
  await writeFile(path, buf);

  await q(
    `UPDATE players SET portrait_path = $2, portrait_mime = $3, portrait_url = NULL,
            author = $4, license = $5, license_url = $6, credit_url = $7,
            attribution_required = $8, lookup_status = 'manual',
            lookup_note = 'set by hand', fetched_at = now()
      WHERE name = $1`,
    [name, path, mime, credit.author ?? null, credit.license ?? null,
     credit.licenseUrl ?? null, credit.creditUrl ?? null,
     !!(credit.license && !/^(cc0|public domain|pd)/i.test(credit.license))],
  );
  return { ok: true, name, bytes: buf.length };
}

/**
 * The cached portrait as a base64 data URI.
 *
 * Inlining is necessary rather than lazy: an SVG loaded through an `<img>` tag is
 * not allowed to fetch external resources, so a referenced portrait would simply
 * not render. Cached in memory because the same faces recur across a 180-tile grid.
 */
const inlineCache = new Map<string, string | null>();

export async function portraitDataUri(player: string): Promise<string | null> {
  if (inlineCache.has(player)) return inlineCache.get(player)!;

  const row = await one<{ portrait_path: string | null; portrait_mime: string | null }>(
    `SELECT portrait_path, portrait_mime FROM players WHERE name = $1`, [player],
  );
  let uri: string | null = null;
  if (row?.portrait_path) {
    try {
      const buf = await readFile(row.portrait_path);
      uri = `data:${row.portrait_mime ?? 'image/jpeg'};base64,${buf.toString('base64')}`;
    } catch {
      // File vanished (volume reset). Forget it so the next backfill re-fetches.
      await q(`UPDATE players SET portrait_path = NULL, lookup_status = 'pending' WHERE name = $1`, [player]);
    }
  }
  if (inlineCache.size > 400) inlineCache.clear();
  inlineCache.set(player, uri);
  return uri;
}

export function clearPortraitCache() { inlineCache.clear(); }
