import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

import { ask } from './ai/nlQuery.js';
import {
  createUser, endSession, findUser, getUser, listUsers, loginBlockedFor, MIN_PASSWORD,
  noteLoginFailure, noteLoginSuccess, ownerUser, pruneSessions, setActive, setPassword,
  SESSION_DAYS, startSession, userForToken, verifyPassword, type User,
} from './auth.js';
import { addHolding, createCustomCard, deleteCustomCard,
         resolveOrCreateSku, setHolding } from './collection.js';
import { SIDES, deletePhoto, listPhotos, photoStats, readPhoto, savePhoto,
         type Side } from './photos.js';
import { capabilities, cfg } from './config.js';
import { q, one } from './db.js';
import { importCompsCsv, importHoldingsCsv, importLegacyJson } from './ingest/csv.js';
import { runIngest } from './ingest/run.js';
import { log } from './logger.js';
import { avatarSvg, cachedFetch, placeholderSvg, refreshImages, resolvePose, upgradeEbayImage } from './media/images.js';
import { POSE_LABELS, POSE_NAMES } from './media/poses.js';
import { scoreCard } from './valuation/scores.js';
import { evaluate, observeOutcomes } from './valuation/shadow.js';
import { describePopulation, psaConfigured, refreshPopulation, storePopulation } from './sources/psa.js';
import { groupedSearchLinks, queryFor } from './search/links.js';
import { parseQuickAdd } from './collection/quickAdd.js';
import { backfillPortraits, portraitDataUri, resolvePlayer, setPortraitManually } from './media/players.js';
import { baseSkuFor } from './match/resolve.js';
import { recommendPortfolio, recommendSku } from './recommend/engine.js';
import { computeVelocity, revalueAll, valueSku, saveValuation } from './valuation/engine.js';
import { marketplaceEcon, netProceeds } from './valuation/fees.js';
import { refreshFx } from './valuation/fx.js';
import { enqueue } from './queue.js';

const app = Fastify({
  logger: false,
  bodyLimit: 20 * 1024 * 1024,
  // See config.TRUST_PROXY. This governs whether req.ip is the browser or the tunnel, which
  // decides whether the login throttle protects accounts or accidentally locks everyone out.
  trustProxy: cfg.TRUST_PROXY,
});
const here = dirname(fileURLToPath(import.meta.url));

await app.register(cookie);
// `origin: true` reflects whatever Origin asked, which combined with credentialed cookies
// would let any website make authenticated requests on a logged-in user's behalf. Same-origin
// only: the page is served by this server, so it has no need to be cross-origin.
await app.register(cors, { origin: false, credentials: true });
await app.register(fastifyStatic, { root: join(here, '..', 'web'), prefix: '/' });

const SESSION_COOKIE = 'cv_session';

/**
 * Who is asking, and how.
 *
 * Two ways in, and they are not equivalent:
 *
 * - **A session cookie** is a person. Their `user_id` scopes every collection query.
 * - **`ADMIN_API_KEY`** is a script — the CLI, cron, `curl`. It has no person attached, so it
 *   acts as the owner account. That is a real privilege escalation and it is the honest
 *   description of what a shared admin secret already was; what changes is that it is now
 *   written down in one place instead of implied by the absence of a check.
 *
 * Attached in a preHandler rather than resolved per route, so a route cannot forget to ask.
 */
declare module 'fastify' {
  interface FastifyRequest {
    principal?: { user: User; via: 'session' | 'api_key' };
  }
}

/** True when accounts are in use at all. A fresh install with no password set is single-user
 *  and must keep working exactly as it did — otherwise upgrading locks you out of your own
 *  collection. */
async function accountsInUse(): Promise<boolean> {
  const r = await one<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM users WHERE pass_algo <> 'unset' AND active`);
  return (r?.n ?? 0) > 0;
}

app.addHook('preHandler', async (req, reply) => {
  const url = req.url.split('?')[0] ?? '';
  const isWrite = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);

  // Resolve identity first, regardless of whether this route needs one.
  const token = (req.cookies as any)?.[SESSION_COOKIE] as string | undefined;
  const sessionUser = await userForToken(token);
  if (sessionUser) {
    req.principal = { user: sessionUser, via: 'session' };
  } else if (cfg.ADMIN_API_KEY && req.headers['x-api-key'] === cfg.ADMIN_API_KEY) {
    const owner = await ownerUser();
    if (owner) req.principal = { user: owner, via: 'api_key' };
  }

  if (!url.startsWith('/api/')) return;               // static files
  if (req.principal) return;

  const live = await accountsInUse();

  /**
   * Single-user mode: nobody has set a password yet.
   *
   * The request becomes the owner. Not "unauthenticated but allowed" — an actual principal —
   * because every collection route now scopes to `principal.user.id`, and a route that is let
   * through with nobody attached 401s from `requireUser` a moment later. That is precisely the
   * bug this replaced: `accountsInUse` was false, the hook waved the request through, and the
   * handler rejected it anyway.
   *
   * Upgrading must not lock you out of your own collection, so the pre-accounts behaviour is
   * preserved exactly: reads open, writes gated by the API key if one is configured.
   */
  if (!live) {
    if (isWrite && cfg.ADMIN_API_KEY) {
      return reply.code(401).send({ error: 'x-api-key required', needKey: true });
    }
    const owner = await ownerUser();
    if (owner) req.principal = { user: owner, via: 'api_key' };
    return;
  }

  // Login and health stay reachable once accounts exist — you cannot sign in through a wall
  // that requires you to already be signed in. Checked here rather than earlier so that in
  // single-user mode they still get the owner principal attached above.
  if (url.startsWith('/api/auth/') || url === '/api/health') return;

  // Everything else needs a person, reads included: reading somebody else's collection is
  // exactly what the login protects.
  return reply.code(401).send({ error: 'sign in', needLogin: true });
});

/** The current user, or a 401. Use in any route that touches owned data. */
function requireUser(req: any, reply: any): User | null {
  if (req.principal?.user) return req.principal.user as User;
  reply.code(401).send({ error: 'sign in', needLogin: true });
  return null;
}

/**
 * Whose collection is this request about?
 *
 * `?user=felix` lets you look at a friend's collection. It is read-only by construction:
 * nothing that writes ever calls this — writes use `requireUser` and scope to that id, so
 * there is no request shape that edits somebody else's cards.
 *
 * Returns `{ target, isSelf }` because almost every caller needs to strip money columns when
 * `isSelf` is false.
 */
async function viewTarget(req: any, reply: any): Promise<{ target: User; isSelf: boolean } | null> {
  const me = requireUser(req, reply);
  if (!me) return null;
  const asked = String((req.query as any)?.user ?? '').trim();
  if (!asked || asked.toLowerCase() === me.username.toLowerCase()) {
    return { target: me, isSelf: true };
  }
  const other = await findUser(asked);
  if (!other || !other.active) {
    reply.code(404).send({ error: `no account called "${asked}"` });
    return null;
  }
  return { target: other, isSelf: false };
}

/**
 * Remove what a friend has no business seeing.
 *
 * Cost basis, and anything derived from it, is the one thing the user asked to keep private.
 * Stripped here rather than omitted from each query on purpose: a single chokepoint can be
 * read and verified, whereas twenty queries each remembering to drop a column is twenty
 * chances to leak. The market value and the sell advice stay — being able to help each other
 * sell is the entire point of sharing.
 */
const PRIVATE_FIELDS = [
  'cost_basis_aud', 'cost_aud', 'total_cost_aud', 'profit_aud', 'profit_pct',
  'unrealized_aud', 'realized_aud', 'acquired_from', 'notes',
];
function redact<T>(rows: T, isSelf: boolean): T {
  if (isSelf || rows == null) return rows;
  const scrub = (o: any): any => {
    if (o == null || typeof o !== 'object') return o;
    if (Array.isArray(o)) return o.map(scrub);
    const out: any = {};
    for (const [k, v] of Object.entries(o)) {
      if (PRIVATE_FIELDS.includes(k)) continue;
      out[k] = v && typeof v === 'object' ? scrub(v) : v;
    }
    return out;
  };
  return scrub(rows);
}

app.setErrorHandler((err: any, _req, reply) => {
  log.error({ err: err?.message, stack: err?.stack }, 'request failed');
  reply.code(err?.statusCode ?? 500).send({ error: err?.message ?? 'internal error' });
});

// ---------------------------------------------------------------------------
// Health & ops
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

/**
 * Cookie settings, and why each one.
 *
 * `httpOnly` — script cannot read it, so an injected script cannot steal the session.
 * `sameSite: 'lax'` — not `strict`, because `strict` drops the cookie when a phone opens the
 *   app from a link in a message, which reads as "it logged me out again".
 * `secure` — only over https. Set from the request rather than hardcoded: forcing it on
 *   would make login silently fail on `http://192.168.x.x` on the house wifi, which is how
 *   this is used today.
 */
function sessionCookieOpts(req: any) {
  const proto = String(req.headers['x-forwarded-proto'] ?? req.protocol ?? 'http');
  return {
    path: '/',
    httpOnly: true as const,
    sameSite: 'lax' as const,
    secure: proto === 'https',
    maxAge: SESSION_DAYS * 24 * 60 * 60,
  };
}

/** What the login screen needs to know before anyone types anything. */
app.get('/api/auth/state', async (req) => {
  const live = await accountsInUse();
  const users = live ? (await listUsers()).filter((u) => u.active) : [];
  return {
    accountsInUse: live,
    // Names only, no counts, no values: this is the one endpoint reachable without a session,
    // so it says as little as it can while still letting the UI offer a list to tap on a phone
    // instead of typing a username.
    people: users.map((u) => ({ username: u.username, displayName: u.display_name })),
    me: req.principal ? {
      username: req.principal.user.username,
      displayName: req.principal.user.display_name,
      role: req.principal.user.role,
      via: req.principal.via,
    } : null,
    minPassword: MIN_PASSWORD,
  };
});

/**
 * First-run setup: name the owner account and give it a password, from the browser.
 *
 * This closes the bootstrap hole that otherwise forces everyone through the CLI. Migration 013
 * creates the owner with an unusable placeholder hash, so there is nobody to log in as — and
 * the alternative, a default password shipped in the repo, is the same default password a year
 * later on a machine now reachable from the internet.
 *
 * Two things make it safe to expose without a session:
 *
 *  - It only works while `accountsInUse()` is false. The moment a password exists this route
 *    returns 409 forever, so it cannot be used to take over an account later.
 *  - In that state the server is already single-user: the preHandler attaches the owner as the
 *    principal and every write is permitted. So this endpoint grants nothing that was not
 *    already available to whoever could reach the page.
 *
 * The window is real but narrow, and it is the same window the CLI has. If you are exposing
 * the server to the internet before setting a password, the tunnel is the mistake, not this.
 */
app.post('/api/auth/setup', async (req, reply) => {
  if (await accountsInUse()) {
    return reply.code(409).send({ error: 'already set up — sign in instead', accountsInUse: true });
  }
  const b = z.object({
    username: z.string().min(2).max(32),
    password: z.string().min(MIN_PASSWORD).max(200),
    displayName: z.string().max(64).nullable().optional(),
  }).parse(req.body ?? {});

  const owner = await ownerUser();
  if (!owner) return reply.code(500).send({ error: 'no owner row — run the migrations' });

  const wanted = b.username.trim();
  if (!/^[a-z0-9._-]{2,32}$/i.test(wanted)) {
    return reply.code(400).send({
      error: 'name must be 2-32 characters: letters, numbers, dot, dash or underscore',
    });
  }
  // Renaming rather than creating: the existing collection is already attached to this row, and
  // a new account would leave every card you own belonging to a name you never chose.
  const clash = await findUser(wanted);
  if (clash && clash.id !== owner.id) {
    return reply.code(400).send({ error: `"${wanted}" is taken` });
  }
  await q(`UPDATE users SET username = $2, display_name = COALESCE($3, $2) WHERE id = $1`,
    [owner.id, wanted, b.displayName?.trim() || null]);
  await setPassword(owner.id, b.password);

  const token = await startSession(owner.id, req.headers['user-agent'] as string);
  reply.setCookie(SESSION_COOKIE, token, sessionCookieOpts(req));
  log.info({ username: wanted }, 'first-run setup complete');
  return { ok: true, me: { username: wanted, displayName: b.displayName || wanted, role: 'owner' } };
});

app.post('/api/auth/login', async (req, reply) => {
  const b = z.object({
    username: z.string().min(1).max(64),
    password: z.string().min(1).max(200),
  }).parse(req.body ?? {});

  const throttleKey = `${b.username.toLowerCase()}|${req.ip}`;
  const waitMs = loginBlockedFor(throttleKey);
  if (waitMs > 0) {
    return reply.code(429).send({
      error: `too many attempts — wait ${Math.ceil(waitMs / 1000)}s`,
      retryAfterMs: waitMs,
    });
  }

  const user = await findUser(b.username);
  const ok = user && user.active && await verifyPassword(b.password, user.pass_hash);
  if (!ok) {
    noteLoginFailure(throttleKey);
    // One message for "no such user" and for "wrong password", deliberately: telling an
    // attacker which usernames exist is free reconnaissance and helps nobody who belongs here.
    return reply.code(401).send({ error: 'wrong username or password' });
  }
  noteLoginSuccess(throttleKey);

  const token = await startSession(user.id, req.headers['user-agent'] as string);
  reply.setCookie(SESSION_COOKIE, token, sessionCookieOpts(req));
  log.info({ username: user.username, ip: req.ip }, 'signed in');
  return {
    ok: true,
    me: { username: user.username, displayName: user.display_name, role: user.role },
  };
});

app.post('/api/auth/logout', async (req, reply) => {
  await endSession((req.cookies as any)?.[SESSION_COOKIE]);
  reply.clearCookie(SESSION_COOKIE, { path: '/' });
  return { ok: true };
});

app.post('/api/auth/password', async (req, reply) => {
  const me = requireUser(req, reply);
  if (!me) return;
  const b = z.object({
    current: z.string().max(200).optional(),
    password: z.string().min(MIN_PASSWORD).max(200),
  }).parse(req.body ?? {});

  // The owner setting their very first password has nothing to prove — migration 013 created
  // the account with an unusable placeholder hash precisely so no default password exists.
  const row = await findUser(me.username);
  const needsCurrent = row && row.pass_hash !== 'x';
  if (needsCurrent && !(await verifyPassword(b.current ?? '', row!.pass_hash))) {
    return reply.code(403).send({ error: 'current password is wrong' });
  }

  await setPassword(me.id, b.password);
  // setPassword kills every session including this one, so hand back a fresh one rather than
  // bouncing the person who just changed their own password to the login screen.
  const token = await startSession(me.id, req.headers['user-agent'] as string);
  reply.setCookie(SESSION_COOKIE, token, sessionCookieOpts(req));
  return { ok: true };
});

/** People, for the account switcher and the "whose collection" picker. */
app.get('/api/users', async (req, reply) => {
  const me = requireUser(req, reply);
  if (!me) return;
  const rows = await listUsers();
  return rows.map((u) => ({
    username: u.username,
    displayName: u.display_name,
    role: u.role,
    active: u.active,
    lines: u.lines,
    isMe: u.id === me.id,
  }));
});

app.post('/api/users', async (req, reply) => {
  const me = requireUser(req, reply);
  if (!me) return;
  if (me.role !== 'owner') {
    return reply.code(403).send({ error: 'only the owner can add accounts' });
  }
  const b = z.object({
    username: z.string().min(2).max(32),
    password: z.string().min(MIN_PASSWORD).max(200),
    displayName: z.string().max(64).nullable().optional(),
  }).parse(req.body ?? {});
  const u = await createUser({
    username: b.username, password: b.password, displayName: b.displayName ?? null,
  });
  return { ok: true, user: { username: u.username, displayName: u.display_name } };
});

app.post('/api/users/:username/active', async (req, reply) => {
  const me = requireUser(req, reply);
  if (!me) return;
  if (me.role !== 'owner') return reply.code(403).send({ error: 'only the owner can do that' });
  const { username } = req.params as any;
  const b = z.object({ active: z.boolean() }).parse(req.body ?? {});
  const target = await findUser(username);
  if (!target) return reply.code(404).send({ error: 'no such account' });
  if (target.role === 'owner' && !b.active) {
    return reply.code(400).send({ error: 'the owner account cannot be disabled' });
  }
  await setActive(target.id, b.active);
  return { ok: true };
});

app.get('/api/health', async () => {
  const db = await one<{ n: number }>(`SELECT COUNT(*)::int AS n FROM cards`).catch(() => null);
  const comps = await one<{ n: number; latest: Date | null }>(
    `SELECT COUNT(*)::int AS n, MAX(sold_at) AS latest FROM comps WHERE NOT excluded AND is_sold`,
  ).catch(() => null);
  return {
    ok: db != null,
    cards: db?.n ?? 0,
    soldComps: comps?.n ?? 0,
    latestComp: comps?.latest ?? null,
    capabilities: capabilities(),
    baseCurrency: cfg.BASE_CURRENCY,
    /**
     * Whether writes require `x-api-key`. Exposed so the UI can ask for the key when the
     * page loads instead of after a write fails — which previously meant typing a
     * fifty-line paste, pressing the button and getting `x-api-key required` with no way
     * to act on it.
     */
    authRequired: Boolean(cfg.ADMIN_API_KEY),
    /** True once anyone has a password: the UI shows a login screen rather than a key box. */
    accountsInUse: await accountsInUse().catch(() => false),
  };
});

/** Per-source health — the page to check when prices stop updating. */
app.get('/api/health/sources', async () => {
  return q(
    `SELECT s.code, s.name, s.kind, s.gives_sold, s.enabled, s.trust_weight,
            r.last_run, r.last_status, r.runs_24h, r.errors_24h, r.items_24h, r.cost_30d
       FROM sources s
       LEFT JOIN (
         SELECT source_code,
                MAX(started_at) AS last_run,
                (ARRAY_AGG(status ORDER BY started_at DESC))[1] AS last_status,
                COUNT(*) FILTER (WHERE started_at > now() - interval '24 hours') AS runs_24h,
                COUNT(*) FILTER (WHERE started_at > now() - interval '24 hours' AND status = 'error') AS errors_24h,
                COALESCE(SUM(items_new) FILTER (WHERE started_at > now() - interval '24 hours'), 0) AS items_24h,
                COALESCE(SUM(cost_units) FILTER (WHERE started_at > now() - interval '30 days'), 0) AS cost_30d
           FROM source_runs GROUP BY source_code
       ) r ON r.source_code = s.code
      ORDER BY s.gives_sold DESC, s.trust_weight DESC`,
  );
});

app.get('/api/health/runs', async (req) => {
  const { limit = '50' } = req.query as any;
  return q(
    `SELECT id, source_code, marketplace_code, started_at, finished_at, status, query,
            items_seen, items_new, cost_units, error
       FROM source_runs ORDER BY started_at DESC LIMIT $1`,
    [Math.min(Number(limit) || 50, 500)],
  );
});

// ---------------------------------------------------------------------------
// Checklist & search
// ---------------------------------------------------------------------------

const CardQuery = z.object({
  search: z.string().optional(),
  product: z.string().optional(),
  section: z.string().optional(),
  team: z.string().optional(),
  hot: z.string().optional(),
  owned: z.string().optional(),
  minValue: z.coerce.number().optional(),
  sort: z.enum(['value', 'player', 'number', 'trend', 'comps']).default('value'),
  limit: z.coerce.number().max(500).default(100),
  offset: z.coerce.number().default(0),
});

app.get('/api/cards', async (req, reply) => {
  const v = await viewTarget(req, reply);
  if (!v) return;
  const p = CardQuery.parse(req.query);
  const where: string[] = ['1=1'];
  // $1 is always the collection being viewed. The holdings join is scoped by it, so
  // `owned_qty` means "how many THEY have", never "how many anybody has".
  const args: any[] = [v.target.id];

  if (p.search) {
    args.push(`%${p.search}%`);
    where.push(`(d.player ILIKE $${args.length} OR d.team ILIKE $${args.length} OR d.card_number = trim('#' from $${args.length}) OR d.label ILIKE $${args.length})`);
  }
  if (p.product) { args.push(p.product); where.push(`d.product_code = $${args.length}`); }
  if (p.section) { args.push(p.section); where.push(`d.section = $${args.length}`); }
  if (p.team) { args.push(p.team); where.push(`d.team = $${args.length}`); }
  if (p.hot === 'true') where.push(`d.hot`);
  if (p.owned === 'true') where.push(`h.sku_id IS NOT NULL AND h.qty > 0`);
  if (p.minValue != null) { args.push(p.minValue); where.push(`COALESCE(v.fair_value_aud, d.seed_est_aud, 0) >= $${args.length}`); }

  const sortSql = {
    value: `COALESCE(v.fair_value_aud, d.seed_est_aud, 0) DESC`,
    player: `d.player ASC`,
    number: `d.product_code, d.section, LPAD(d.card_number, 6, '0')`,
    trend: `v.trend_30d_pct DESC NULLS LAST`,
    comps: `v.n_comps DESC NULLS LAST`,
  }[p.sort];

  args.push(p.limit, p.offset);
  return q(
    `SELECT d.sku_id, d.label, d.legacy_id, d.product_code, d.product_name, d.section,
            d.card_number, d.player, d.team, d.subset, d.hot, d.seed_est_aud,
            d.parallel_name, d.grader, d.grade,
            v.fair_value_aud, v.median_aud, v.low_aud, v.high_aud, v.n_comps,
            v.trend_30d_pct, v.trend_90d_pct, v.method, v.confidence, v.as_of AS priced_at,
            h.qty AS owned_qty, h.price_override_aud,
            r.action, r.best_marketplace_code, r.best_net_aud, r.score, r.urgency
       FROM sku_detail d
       LEFT JOIN latest_valuation v ON v.sku_id = d.sku_id AND v.marketplace_code IS NULL
       LEFT JOIN holdings h ON h.sku_id = d.sku_id AND h.user_id = $1
       LEFT JOIN latest_recommendation r ON r.sku_id = d.sku_id
      WHERE ${where.join(' AND ')}
      ORDER BY ${sortSql}
      LIMIT $${args.length - 1} OFFSET $${args.length}`,
    args,
  ).then((rows) => redact(rows, v.isSelf));
});

app.get('/api/cards/:skuId', async (req) => {
  const { skuId } = req.params as any;
  const detail = await one(`SELECT * FROM sku_detail WHERE sku_id = $1`, [skuId]);
  if (!detail) return { error: 'not found' };

  const [valuations, comps, velocity, rec, siblings, pop, ctx] = await Promise.all([
    q(`SELECT marketplace_code, as_of, n_comps, fair_value_aud, median_aud, low_aud, high_aud,
              trend_30d_pct, volatility, method, confidence
         FROM valuations WHERE sku_id = $1 ORDER BY as_of DESC LIMIT 60`, [skuId]),
    q(`SELECT c.sold_at, c.price_aud, c.price_native, c.currency, c.marketplace_code,
              c.match_method, c.match_confidence, c.excluded, c.exclude_reason,
              l.title, l.url, l.format, l.bids, l.source_code
         FROM comps c JOIN listings l ON l.id = c.listing_id
        WHERE c.sku_id = $1 ORDER BY c.sold_at DESC LIMIT 120`, [skuId]),
    q(`SELECT * FROM velocity WHERE sku_id = $1 ORDER BY as_of DESC LIMIT 10`, [skuId]),
    one(`SELECT * FROM latest_recommendation WHERE sku_id = $1`, [skuId]),
    q(`SELECT s.id AS sku_id, s.label, p.name AS parallel_name, p.print_run, s.grader, s.grade,
              v.fair_value_aud, v.n_comps
         FROM skus s
         LEFT JOIN parallels p ON p.id = s.parallel_id
         LEFT JOIN latest_valuation v ON v.sku_id = s.id AND v.marketplace_code IS NULL
        WHERE s.card_id = (SELECT card_id FROM skus WHERE id = $1)
        ORDER BY COALESCE(v.fair_value_aud, 0) DESC`, [skuId]),
    one(`SELECT pp.*, s.grade FROM psa_population pp JOIN skus s ON s.id = pp.sku_id
          WHERE pp.sku_id = $1`, [skuId]),
    // The set's top value, so `market` can place this card on a scale instead of
    // reporting an unanchored dollar figure.
    one<{ top_value_aud: number | null; spm: number | null }>(
      `SELECT (SELECT MAX(COALESCE(v.fair_value_aud, d2.seed_est_aud))
                 FROM sku_detail d2
                 LEFT JOIN latest_valuation v ON v.sku_id = d2.sku_id AND v.marketplace_code IS NULL
                WHERE d2.product_code = (SELECT product_code FROM sku_detail WHERE sku_id = $1)
              ) AS top_value_aud,
              -- velocity records sales_per_day; the score wants a monthly rate.
              (SELECT sales_per_day * 30 FROM velocity
                WHERE sku_id = $1 AND marketplace_code IS NULL
                ORDER BY as_of DESC LIMIT 1) AS spm`, [skuId]),
  ]);

  const d: any = detail;
  // Three axes, never one composite. See src/valuation/scores.ts for why.
  const scores = scoreCard({
    print_run: d.print_run, parallel_name: d.parallel_name, card_type: d.card_type,
    grader: d.grader, grade: d.grade, condition: d.condition,
    value_aud: d.fair_value_aud ?? d.seed_est_aud,
    top_value_aud: ctx?.top_value_aud ?? null,
    trend_30d_pct: d.trend_30d_pct, n_comps: d.n_comps, confidence: d.confidence,
    sales_per_month: ctx?.spm ?? null,
  });

  return {
    detail, valuations, comps, velocity, recommendation: rec, siblings, scores,
    // A third axis, alongside the three scores and pointedly not inside them.
    population: pop ? { ...pop, summary: describePopulation(pop as any) } : null,
    populationAvailable: psaConfigured(),
  };
});

// ---------------------------------------------------------------------------
// Imagery
// ---------------------------------------------------------------------------

/**
 * Card image for a SKU. Always returns a renderable image: the cached real photo
 * when we have one, a generated card-shaped SVG when we don't. Never a 404 — a
 * gallery that shows broken-image icons is worse than no gallery.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS RESPONSE IS `private` AND VARIES ON THE COOKIE
 * ---------------------------------------------------------------------------
 *
 * It used to send `public, max-age=86400` for the generated placeholder and the harvested
 * listing photo, which was correct while one URL had one answer for everybody. Per-person
 * photographs broke that assumption, and it broke in two ways at once:
 *
 *  1. Cosmetic but immediately visible — photograph a card and the tile keeps showing the
 *     old generated art, because the browser has a day-long cached copy and never asks
 *     again. The feature looks like it silently failed.
 *  2. Not cosmetic at all — a shared cache in front of this app (and there is one: the
 *     Cloudflare tunnel) could store MY photograph under this URL and hand it to the next
 *     person who asks for the same card. `public` on a response whose content depends on the
 *     caller is exactly how that happens.
 *
 * `private` stops shared caches storing it; `Vary: Cookie` stops any cache that does store
 * it from serving one person's photo to another. Both, rather than either, because they fail
 * differently and the failure mode of getting this wrong is showing somebody else's property
 * as yours.
 */
app.get('/api/img/:skuId', async (req, reply) => {
  const { skuId } = req.params as any;
  reply.header('Vary', 'Cookie');
  const d = await one<any>(
    `SELECT player, team, section, card_number, product_code, parallel_name,
            print_run, grader, grade, hot, subset, image_url, image_path
       FROM sku_detail WHERE sku_id = $1`,
    [skuId],
  );
  if (!d) return reply.code(404).send({ error: 'not found' });

  /**
   * Your own front photograph wins over everything, including the shared upload below.
   *
   * The precedence is: my photo of my copy > the shared/legacy upload > a picture harvested
   * from a sold listing > generated art. The first rung is new and is the whole point of
   * per-person photographs: when you look at your collection you should see YOUR cards, not
   * a stock image and not your friend's copy. Falling through on a missing file rather than
   * erroring keeps the old behaviour that a gallery never shows broken images.
   */
  if (req.principal?.user) {
    const own = await one<{ id: number }>(
      `SELECT id FROM card_photos WHERE user_id = $1 AND sku_id = $2 AND side = 'front'`,
      [req.principal.user.id, skuId],
    );
    if (own) {
      const found = await readPhoto(Number(own.id));
      if (found) {
        return reply
          .header('Content-Type', found.mime)
          .header('Cache-Control', 'private, max-age=60')
          .header('X-Image-Source', 'own-photo')
          .send(found.body);
      }
    }
  }

  // The older shared upload, kept working: one photo per SKU for the whole database.
  if (d.image_path) {
    try {
      const body = await readFile(d.image_path);
      const ext = d.image_path.split('.').pop()?.toLowerCase();
      const type = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp'
        : ext === 'gif' ? 'image/gif' : ext === 'avif' ? 'image/avif' : 'image/jpeg';
      return reply
        .header('Content-Type', type)
        .header('Cache-Control', 'private, max-age=60')
        .header('X-Image-Source', 'upload')
        .send(body);
    } catch {
      // File gone (volume reset, manual delete). Forget it and fall through.
      await q(`UPDATE skus SET image_path = NULL, image_source = NULL WHERE id = $1`, [skuId]);
    }
  }

  if (d.image_url) {
    const img = await cachedFetch(d.image_url);
    if (img) {
      return reply
        .header('Content-Type', img.contentType)
        .header('Cache-Control', 'private, max-age=604800')
        .header('X-Image-Source', img.fromCache ? 'cache' : 'upstream')
        .send(img.body);
    }
    // Upstream image died (listing deleted). Fall through to the placeholder
    // rather than serving a broken image, and forget the dead URL.
    await q(`UPDATE skus SET image_url = NULL WHERE id = $1 AND image_url = $2`, [skuId, d.image_url]);
  }

  // No card photograph — fall back to generated art, with the player's face in it
  // if we have a licensed portrait.
  //
  // Two minutes, not the day this used to hold for. A placeholder is precisely the response
  // that is about to stop being true — you are looking at it because the card has no photo,
  // and the obvious next thing you do is give it one. Caching "no photo yet" for a day means
  // the first thing the feature does after you use it is appear not to have worked.
  const portrait = await portraitDataUri(d.player).catch(() => null);
  return reply
    .header('Content-Type', 'image/svg+xml')
    .header('Cache-Control', 'private, max-age=120')
    .header('X-Image-Source', portrait ? 'generated+portrait' : 'generated')
    .send(placeholderSvg({ ...d, portraitDataUri: portrait }));
});

/** Player avatar: the licensed portrait, or a monogram disc. */
app.get('/api/img/player/:name', async (req, reply) => {
  const name = decodeURIComponent((req.params as any).name);

  /**
   * Your own card outranks everything, including a Commons portrait of the player.
   *
   * A portrait is a photograph of a footballer; a card you photographed is a picture of the
   * thing you actually own, and in a collection app that is the more useful image by a wide
   * margin. It is also the only one that reflects *your* copy — the corners, the centring, the
   * gloss. Same principle as `/api/img/:skuId` preferring an upload over a harvested listing
   * image, extended one level up.
   *
   * Scoped to the requesting person: a friend browsing your collection sees the cards you
   * photographed, and you do not inherit their photos as your player pictures. `image_source`
   * must be 'upload' — a harvested listing image is somebody else's copy and has no business
   * standing in for the player.
   *
   * Highest-value card first, on the theory that the nicest card is the one worth looking at.
   */
  const mine = req.principal
    ? await one<{ image_path: string }>(
        `SELECT s.image_path
           FROM holdings h
           JOIN skus s ON s.id = h.sku_id
           JOIN cards c ON c.id = s.card_id
           LEFT JOIN latest_valuation v ON v.sku_id = s.id AND v.marketplace_code IS NULL
          WHERE h.user_id = $2 AND h.qty > 0 AND c.player = $1
            AND s.image_path IS NOT NULL AND s.image_source = 'upload'
          ORDER BY COALESCE(v.fair_value_aud, 0) DESC, s.image_updated_at DESC NULLS LAST
          LIMIT 1`, [name, req.principal.user.id])
    : null;
  if (mine?.image_path) {
    try {
      const body = await readFile(mine.image_path);
      const ext = mine.image_path.split('.').pop()?.toLowerCase();
      const type = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp'
        : ext === 'gif' ? 'image/gif' : ext === 'avif' ? 'image/avif' : 'image/jpeg';
      return reply
        .header('Content-Type', type)
        // `private`, and short: this is one person's photo, so a shared cache must never hand
        // it to another account, and swapping the photo should show up quickly.
        .header('Cache-Control', 'private, max-age=60')
        .header('X-Image-Source', 'own-card')
        .send(body);
    } catch { /* file went missing; fall through to the portrait or the kit */ }
  }

  const portrait = await portraitDataUri(name).catch(() => null);
  const row = await one<{ team: string | null; position: string | null; pose: string | null; hot: boolean | null }>(
    `SELECT (SELECT MIN(team) FROM cards WHERE player = $1) AS team,
            (SELECT BOOL_OR(hot) FROM cards WHERE player = $1) AS hot,
            p.position, p.pose_override AS pose
       FROM players p WHERE p.name = $1`, [name],
  ) ?? await one<{ team: string | null; position: string | null; pose: string | null; hot: boolean | null }>(
    // A custom card can name a player who has no players row yet.
    `SELECT MIN(team) AS team, BOOL_OR(hot) AS hot, NULL::text AS position, NULL::text AS pose
       FROM cards WHERE player = $1`, [name],
  );
  // Without a photograph, dress the silhouette in the national kit — it is the
  // difference between a wall of identical placeholders and a readable grid.
  const kit = row?.team
    ? await one<{ primary_hex: string; secondary_hex: string; pattern: string; verified: boolean }>(
        `SELECT primary_hex, secondary_hex, pattern, verified FROM nation_kits WHERE team = $1`,
        [row.team])
    : null;
  return reply
    .header('Content-Type', 'image/svg+xml')
    .header('Cache-Control', 'public, max-age=86400')
    .header('X-Image-Source', portrait ? 'portrait' : (kit ? 'generated+kit' : 'generated'))
    .header('X-Pose', portrait ? 'none' : resolvePose(row?.pose, row?.position))
    // A CSS media query *inside* an SVG loaded through <img> does not see the user's
    // reduced-motion setting — verified, not assumed, in tools/check-avatars.mjs. So the
    // decision moves out of the image: the client hint below when the browser sends it,
    // and ?anim=0 from the dashboard, which computes matchMedia itself. The in-SVG query
    // stays as a third line of defence where it does work.
    .header('Accept-CH', 'Sec-CH-Prefers-Reduced-Motion')
    .header('Vary', 'Sec-CH-Prefers-Reduced-Motion')
    .send(avatarSvg({ player: name, team: row?.team ?? null, portraitDataUri: portrait, kit,
                      position: row?.position ?? null, pose: row?.pose ?? null,
                      // The marquee staging goes to the players a collection is actually
                      // about: icons, and anyone the checklist flags hot.
                      iconic: row?.hot === true || /messi|ronaldo/i.test(name),
                      animate: (req.query as any)?.anim !== '0'
                        && (req.headers['sec-ch-prefers-reduced-motion'] as string) !== 'reduce' }));
});

/** The pose vocabulary, so the UI can offer them without hardcoding the list. */
app.get('/api/poses', async () => {
  // Counting in JS rather than SQL keeps one copy of the mapping. Duplicating the
  // position→pose rules in SQL is exactly how the two drift apart.
  const rows = await q<{ position: string | null; pose_override: string | null; n: number }>(
    `SELECT position, pose_override, COUNT(*)::int AS n
       FROM players GROUP BY position, pose_override`);
  const tally = new Map<string, number>();
  for (const r of rows) {
    const pose = resolvePose(r.pose_override, r.position);
    tally.set(pose, (tally.get(pose) ?? 0) + r.n);
  }
  return POSE_NAMES.map((pose) => ({ pose, label: POSE_LABELS[pose], players: tally.get(pose) ?? 0 }));
});

/**
 * Pin a pose, or clear it.
 *
 * Sets `position_source = 'manual'` so a later Wikidata backfill can't quietly
 * overrule a choice you made by hand.
 */
app.post('/api/players/:name/pose', async (req, reply) => {
  const name = decodeURIComponent((req.params as any).name);
  const body = z.object({
    pose: z.string().nullable().optional(),
    position: z.string().max(60).nullable().optional(),
  }).parse((req as any).body ?? {});

  if (body.pose != null && body.pose !== '' && !POSE_NAMES.includes(body.pose as any)) {
    return reply.code(400).send({ error: `unknown pose; expected one of ${POSE_NAMES.join(', ')}` });
  }
  const rows = await q(
    `UPDATE players
        SET pose_override = $2,
            position = COALESCE($3, position),
            position_source = CASE WHEN $3::text IS NULL THEN position_source ELSE 'manual' END
      WHERE name = $1
      RETURNING name, position, position_source, pose_override`,
    [name, body.pose === '' ? null : body.pose ?? null, body.position ?? null],
  );
  if (!rows.length) return reply.code(404).send({ error: 'no such player' });
  return { ...rows[0], pose: resolvePose((rows[0] as any).pose_override, (rows[0] as any).position) };
});

/**
 * Club data health.
 *
 * Freshness affects *presentation*, never whether the filter exists: a Chelsea option
 * that disappears overnight because a threshold elapsed reads as a broken app, and the
 * data didn't stop being useful — it got less certain. So this endpoint exists to say
 * how certain, in one place, and the gallery just shows the club.
 */
/**
 * What the shadow log has learned so far — usually "not enough yet", said plainly.
 *
 * This endpoint exists to stop the tempting mistake: retuning the market weights against
 * the same handful of sales that produced them. It reports how many *independent*
 * situations have been observed, not how many rows, because twenty sales of one Yamal
 * parallel is one market situation sampled twenty times.
 */
app.get('/api/shadow', async () => evaluate());

app.post('/api/shadow/observe', async () => observeOutcomes());

/** Population for one graded card. Needs PSA_API_TOKEN; no scraping fallback. */
app.post('/api/cards/:skuId/population', async (req, reply) => {
  const skuId = Number((req.params as any).skuId);
  const body = z.object({
    specId: z.coerce.number().optional(),
    certNumber: z.string().max(40).optional(),
    // Manual entry, for when you have the pop report open in a browser and no API token.
    total: z.coerce.number().optional(),
    atGrade: z.coerce.number().optional(),
    higher: z.coerce.number().optional(),
  }).parse((req as any).body ?? {});

  if (body.total != null) {
    await storePopulation(skuId, {
      total: body.total, atGrade: body.atGrade ?? null, higher: body.higher ?? null,
      gemRate: null, byGrade: null, source: 'manual', note: 'entered by hand',
    });
    return { ok: true, source: 'manual' };
  }
  if (!psaConfigured()) {
    return reply.code(400).send({
      error: 'PSA_API_TOKEN is not set. Either set it, or POST {total, atGrade, higher} '
           + 'to record the figures by hand — there is no scraper here on purpose.',
    });
  }
  return refreshPopulation(skuId, { specId: body.specId, certNumber: body.certNumber });
});

/**
 * Where to go looking for one card, as links rather than as a scraper.
 *
 * See src/search/links.ts for why this cannot be automated: Facebook Marketplace needs a
 * logged-in session and publishes asking prices, not sales, and Google has no free result
 * API. Building the URL is the honest ceiling.
 */
app.get('/api/search-links/:skuId', async (req, reply) => {
  const skuId = Number((req.params as any).skuId);
  const d = await one<any>(
    `SELECT player, team, section, card_number, product_code, parallel_name, print_run,
            grader, grade
       FROM sku_detail WHERE sku_id = $1`, [skuId]);
  if (!d) return reply.code(404).send({ error: 'not found' });

  return {
    query: queryFor({ player: d.player, section: d.section, cardNumber: d.card_number,
                      parallelName: d.parallel_name, printRun: d.print_run,
                      grader: d.grader, grade: d.grade, productCode: d.product_code }),
    groups: groupedSearchLinks({
      player: d.player, team: d.team, section: d.section, cardNumber: d.card_number,
      parallelName: d.parallel_name, printRun: d.print_run,
      grader: d.grader, grade: d.grade, productCode: d.product_code,
    }),
    caveat: 'Nothing here is fetched automatically. Facebook Marketplace has no public '
          + 'listing API and shows asking prices; Google has no free results API. Real '
          + 'regional prices come from marketplace comps instead — see /api/regions.',
  };
});

/**
 * Regional demand, measured from sold comps.
 *
 * This is the answer to "is this trendy in Europe or China" that is actually defensible:
 * what the card sold for, per marketplace, net of that venue's fees and realization. It
 * reports `n_comps` on every row because a region with one sale has told you nothing, and
 * a UI that hides that is worse than one that shows no map at all.
 */
app.get('/api/regions', async (req) => {
  const skuId = Number((req.query as any).skuId);

  const rows = skuId
    ? await q(`SELECT * FROM regional_demand WHERE sku_id = $1 ORDER BY net_median_aud DESC NULLS LAST`, [skuId])
    : await q(`SELECT r.region,
                      COUNT(DISTINCT r.sku_id)::int          AS cards,
                      SUM(r.n_comps)::int                    AS n_comps,
                      percentile_cont(0.5) WITHIN GROUP (ORDER BY r.median_aud)     AS median_aud,
                      percentile_cont(0.5) WITHIN GROUP (ORDER BY r.net_median_aud) AS net_median_aud,
                      MAX(r.last_sold_at)                    AS last_sold_at,
                      ARRAY_AGG(DISTINCT r.marketplace)      AS marketplaces
                 FROM regional_demand r
                GROUP BY r.region
                ORDER BY n_comps DESC`);

  // The comparison is only meaningful against a baseline, and AU is the seller's home
  // market — so premiums are expressed relative to it rather than to a global average
  // that includes the region being compared.
  const home = (rows as any[]).find((r) => r.region === 'AU');
  const base = home ? Number(home.net_median_aud ?? home.median_aud) : null;
  return {
    scope: skuId ? 'card' : 'collection',
    baseline: home ? { region: 'AU', net_median_aud: base } : null,
    rows: (rows as any[]).map((r) => ({
      ...r,
      vs_home_pct: base && base > 0 && r.net_median_aud != null
        ? Math.round(((Number(r.net_median_aud) / base) - 1) * 1000) / 10
        : null,
      // Stated, not implied. Three comps is where a median stops being an anecdote.
      confidence: Number(r.n_comps) >= 8 ? 'usable'
        : Number(r.n_comps) >= 3 ? 'thin' : 'anecdote',
    })),
    note: 'Median sold price per marketplace region, net of that venue\'s fees and price '
        + 'realization. Regions with fewer than three sales are labelled anecdote and '
        + 'should not be compared.',
  };
});

/**
 * Seller locations, at the only grain the data supports.
 *
 * eBay returns an item location: usually country plus state, sometimes a city, often
 * nothing. This aggregates exactly that. There is no suburb-level sold-price source
 * anywhere, so a Melbourne-suburb heat map would be invented precision — and the
 * `located` / `total` counts below exist so you can see how much of the data is even
 * geocoded before drawing conclusions from it.
 */
app.get('/api/geo', async (req) => {
  const skuId = Number((req.query as any).skuId);
  const where = skuId ? 'AND c.sku_id = $1' : '';
  const args = skuId ? [skuId] : [];

  const [countries, regions, coverage] = await Promise.all([
    q(`SELECT l.seller_country AS country, COUNT(*)::int AS n_comps,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY c.price_aud) AS median_aud
         FROM comps c JOIN listings l ON l.id = c.listing_id
        WHERE NOT c.excluded AND l.seller_country IS NOT NULL ${where}
        GROUP BY 1 ORDER BY n_comps DESC LIMIT 25`, args),
    q(`SELECT l.seller_country AS country, l.seller_region AS region,
              l.seller_city AS city, COUNT(*)::int AS n_comps,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY c.price_aud) AS median_aud
         FROM comps c JOIN listings l ON l.id = c.listing_id
        WHERE NOT c.excluded AND l.seller_region IS NOT NULL ${where}
        GROUP BY 1,2,3 ORDER BY n_comps DESC LIMIT 40`, args),
    one(`SELECT COUNT(*)::int AS total,
                COUNT(l.seller_country)::int AS located,
                COUNT(l.seller_region)::int AS with_region,
                COUNT(l.seller_city)::int AS with_city
           FROM comps c JOIN listings l ON l.id = c.listing_id
          WHERE NOT c.excluded ${where}`, args),
  ]);

  return {
    countries, regions, coverage,
    note: 'Seller location as the source reports it. eBay gives country, usually a state '
        + 'and sometimes a city — never a suburb, and often nothing at all, which is why '
        + 'the coverage counts are here. Note this is where the SELLER is, not the buyer: '
        + 'for demand by region use /api/regions instead.',
  };
});

app.get('/api/clubs/health', async () => {
  const [buckets, resolutions, stalest] = await Promise.all([
    q(`SELECT CASE
                 WHEN club IS NULL THEN 'no club'
                 WHEN club_checked_at IS NULL THEN 'never checked'
                 WHEN now() - club_checked_at < INTERVAL '14 days' THEN 'fresh'
                 WHEN now() - club_checked_at < INTERVAL '45 days' THEN 'ageing'
                 ELSE 'stale'
               END AS bucket,
               COUNT(*)::int AS players
          FROM players p
         WHERE EXISTS (SELECT 1 FROM cards c WHERE c.player = p.name)
         GROUP BY 1 ORDER BY 2 DESC`),
    q(`SELECT COALESCE(club_resolution, 'not looked up') AS resolution, COUNT(*)::int AS players
          FROM players p
         WHERE EXISTS (SELECT 1 FROM cards c WHERE c.player = p.name)
         GROUP BY 1 ORDER BY 2 DESC`),
    q(`SELECT name, club, club_source, club_revision,
              EXTRACT(DAY FROM now() - club_checked_at)::int AS age_days
          FROM players
         WHERE club IS NOT NULL
         ORDER BY club_checked_at ASC NULLS FIRST
         LIMIT 8`),
  ]);
  return {
    buckets, resolutions, stalest,
    thresholds: { freshDays: 14, ageingDays: 45 },
    note: 'Squads change every transfer window. Clubs are a snapshot, not a fact — '
        + 'the filter never hides players, it just stops claiming certainty.',
  };
});

app.get('/api/kits', async () => q(
  `SELECT k.*, (SELECT COUNT(*)::int FROM cards c WHERE c.team = k.team) AS cards
     FROM nation_kits k ORDER BY cards DESC`));

/**
 * Render the artwork for a hypothetical version, creating nothing.
 *
 * The add dialog calls this on every change so the picture updates as you pick
 * Base vs Optic vs Kaboom, or a parallel, or a grade. Resolving a real SKU would
 * work too, but it would litter the database with a SKU per keystroke.
 */
app.get('/api/img/preview', async (req, reply) => {
  const p = req.query as any;
  const svg = placeholderSvg({
    player: String(p.player ?? '?'),
    team: p.team ? String(p.team) : null,
    section: String(p.section ?? 'Base'),
    card_number: String(p.cardNumber ?? '—'),
    product_code: String(p.productCode ?? 'A'),
    parallel_name: p.parallelName ? String(p.parallelName) : null,
    print_run: p.printRun ? Number(p.printRun) : null,
    grader: p.grader ? String(p.grader) : null,
    grade: p.grade ? Number(p.grade) : null,
    hot: false,
    subset: p.subset ? String(p.subset) : '',
  });
  return reply.header('Content-Type', 'image/svg+xml')
    .header('Cache-Control', 'public, max-age=3600').send(svg);
});

/**
 * Go and find a real photograph for one card, now.
 *
 * Runs a targeted ingest for that card only, then harvests whatever image came
 * back. This is the button to press when you want the actual picture rather than
 * generated art and don't want to wait for the nightly cycle.
 */
app.post('/api/img/find/:skuId', async (req) => {
  const { skuId } = req.params as any;
  const d = await one<{ card_id: number; label: string }>(
    `SELECT card_id, label FROM sku_detail WHERE sku_id = $1`, [skuId],
  );
  if (!d) return { error: 'not found' };

  const before = await one<{ image_source: string | null }>(
    `SELECT image_source FROM sku_detail WHERE sku_id = $1`, [skuId],
  );
  const run = await runIngest({ mode: 'card', cardIds: [d.card_id], includeAsks: true });
  const harvest = await refreshImages({ limit: 50 });
  const after = await one<{ image_source: string | null }>(
    `SELECT image_source FROM sku_detail WHERE sku_id = $1`, [skuId],
  );

  return {
    ok: true,
    found: !!after?.image_source && after.image_source !== before?.image_source,
    imageSource: after?.image_source ?? null,
    requests: run.requests,
    listings: run.listings,
    note: run.requests === 0
      ? 'No ingest source is configured, so there was nothing to search. Add eBay credentials or enable Bright Data, or upload your own photo.'
      : after?.image_source
        ? 'Photo found.'
        : 'Searched, but no listing with a usable photo matched this exact version.',
    harvest,
  };
});

app.post('/api/images/refresh', async (req) => {
  const { limit } = (req.body ?? {}) as any;
  return refreshImages({ limit });
});

/** Manually pin an image (e.g. your own scan) to a SKU. */
app.post('/api/images/:skuId', async (req) => {
  const { skuId } = req.params as any;
  const { url } = (req.body ?? {}) as any;
  if (typeof url !== 'string' || !/^https?:\/\//.test(url)) return { error: 'valid url required' };
  await q(
    `UPDATE skus SET image_url = $2, image_source = 'manual', image_updated_at = now() WHERE id = $1`,
    [skuId, upgradeEbayImage(url)],
  );
  return { ok: true };
});

// ---------------------------------------------------------------------------
// Gallery + chart data
// ---------------------------------------------------------------------------

const GalleryQuery = z.object({
  view: z.enum(['owned', 'all', 'hot', 'actions', 'movers']).default('owned'),
  search: z.string().optional(),
  product: z.string().optional(),
  section: z.string().optional(),
  team: z.string().optional(),
  position: z.string().optional(),
  club: z.string().optional(),
  action: z.string().optional(),
  minValue: z.coerce.number().optional(),
  sort: z.enum(['value', 'stakes', 'trend', 'player', 'number', 'comps']).default('value'),
  limit: z.coerce.number().max(600).default(120),
  offset: z.coerce.number().default(0),
});

/**
 * The gallery endpoint. Returns everything a card tile needs in one request —
 * image, price, trend, action, sparkline series — because a picture grid that
 * fires a second request per tile to find its own price is unusable at 120 tiles.
 */
app.get('/api/gallery', async (req, reply) => {
  const v = await viewTarget(req, reply);
  if (!v) return;
  const p = GalleryQuery.parse(req.query);
  const where: string[] = ['1=1'];
  // $1 is the collection being viewed — see /api/cards for why the holdings join carries it.
  const args: any[] = [v.target.id];

  if (p.view === 'owned') where.push('h.qty > 0');
  if (p.view === 'hot') where.push('d.hot');
  if (p.view === 'actions') where.push(`h.qty > 0 AND r.action IN ('sell_now','sell_soon','grade_then_sell','lot_it')`);
  if (p.view === 'movers') where.push('v.n_comps >= 3 AND v.trend_30d_pct IS NOT NULL');

  if (p.search) {
    args.push(`%${p.search}%`);
    where.push(`(d.player ILIKE $${args.length} OR d.team ILIKE $${args.length} OR d.label ILIKE $${args.length})`);
  }
  if (p.product) { args.push(p.product); where.push(`d.product_code = $${args.length}`); }
  if (p.section) { args.push(p.section); where.push(`d.section = $${args.length}`); }
  if (p.team) { args.push(p.team); where.push(`d.team = $${args.length}`); }
  // Position and club live on the player, not the card, so they filter by subquery
  // rather than by join — sku_detail is already wide and a join here would multiply
  // rows for any player with two rows in `players` after a rename.
  if (p.position) {
    if (p.position === 'unknown') {
      where.push(`NOT EXISTS (SELECT 1 FROM players pp WHERE pp.name = d.player AND pp.position IS NOT NULL)`);
    } else {
      args.push(p.position);
      where.push(`EXISTS (SELECT 1 FROM players pp WHERE pp.name = d.player AND pp.position = $${args.length})`);
    }
  }
  if (p.club) {
    if (p.club === 'unknown') {
      where.push(`NOT EXISTS (SELECT 1 FROM players pp WHERE pp.name = d.player AND pp.club IS NOT NULL)`);
    } else {
      args.push(p.club);
      where.push(`EXISTS (SELECT 1 FROM players pp WHERE pp.name = d.player AND pp.club = $${args.length})`);
    }
  }
  if (p.action) { args.push(p.action); where.push(`r.action = $${args.length}`); }
  if (p.minValue != null) {
    args.push(p.minValue);
    where.push(`COALESCE(h.price_override_aud, v.fair_value_aud, d.seed_est_aud, 0) >= $${args.length}`);
  }

  const sortSql = {
    value: `COALESCE(h.price_override_aud, v.fair_value_aud, d.seed_est_aud, 0) DESC`,
    stakes: `r.score DESC NULLS LAST`,
    trend: `v.trend_30d_pct DESC NULLS LAST`,
    player: `d.player ASC`,
    number: `d.product_code, d.section, LPAD(d.card_number, 6, '0')`,
    comps: `v.n_comps DESC NULLS LAST`,
  }[p.sort];

  args.push(p.limit, p.offset);
  return q(
    `SELECT d.sku_id, d.label, d.player, d.team, d.section, d.card_number, d.subset,
            d.product_code, d.product_name, d.parallel_name, d.print_run, d.grader, d.grade, d.hot,
            d.image_source, d.card_type, d.variant_type, d.is_rookie, d.is_custom, d.found_in,
            h.acquired_from, h.condition, bx.name AS box_name, bx.channel AS box_channel,
            COALESCE(h.price_override_aud, v.fair_value_aud, d.seed_est_aud) AS value_aud,
            v.low_aud, v.high_aud, v.n_comps, v.trend_30d_pct, v.confidence,
            -- a card priced only from the carried-over estimate has no valuation
            -- row at all; report that honestly rather than as "no data"
            COALESCE(v.method, CASE WHEN d.seed_est_aud IS NOT NULL THEN 'seed' END) AS method,
            h.qty AS owned_qty, h.price_override_aud,
            r.action, r.best_marketplace_code, r.best_net_aud, r.score, r.urgency,
            (r.communities -> 0 ->> 'name') AS top_community,
            -- compact price series for the tile sparkline
            (SELECT json_agg(json_build_object('t', x.sold_at, 'v', x.price_aud) ORDER BY x.sold_at)
               FROM (SELECT c2.sold_at, c2.price_aud FROM comps c2
                      WHERE c2.sku_id = d.sku_id AND NOT c2.excluded AND c2.is_sold
                      ORDER BY c2.sold_at DESC LIMIT 40) x) AS series
       FROM sku_detail d
       LEFT JOIN latest_valuation v ON v.sku_id = d.sku_id AND v.marketplace_code IS NULL
       LEFT JOIN holdings h ON h.sku_id = d.sku_id AND h.user_id = $1
       LEFT JOIN product_boxes bx ON bx.id = h.box_id
       LEFT JOIN latest_recommendation r ON r.sku_id = d.sku_id
      WHERE ${where.join(' AND ')}
      ORDER BY ${sortSql}
      LIMIT $${args.length - 1} OFFSET $${args.length}`,
    args,
  ).then((rows) => redact(rows, v.isSelf));
});

/** Aggregates for the dashboard charts, in one request. */
app.get('/api/overview', async (req, reply) => {
  const v = await viewTarget(req, reply);
  if (!v) return;
  const uid = v.target.id;
  const [totals, bySection, byAction, coverage, valueBands, recentSales, topMovers,
         byType, byBox] = await Promise.all([
    one(`SELECT COUNT(*)::int AS lines, COALESCE(SUM(qty),0)::int AS cards,
                COALESCE(SUM(total_value_aud),0) AS value_aud,
                COALESCE(SUM(cost_basis_aud * qty),0) AS cost_aud,
                COUNT(*) FILTER (WHERE n_comps > 0)::int AS comp_backed,
                COALESCE(SUM(total_value_aud) FILTER (WHERE n_comps > 0),0) AS value_comp_backed
           FROM portfolio WHERE user_id = $1`, [uid]),
    q(`SELECT section, COALESCE(SUM(total_value_aud),0) AS value_aud, COUNT(*)::int AS lines
         FROM portfolio WHERE user_id = $1 GROUP BY section ORDER BY value_aud DESC`, [uid]),
    q(`SELECT COALESCE(action,'unscored') AS action, COUNT(*)::int AS lines,
              COALESCE(SUM(total_value_aud),0) AS value_aud
         FROM portfolio WHERE user_id = $1 GROUP BY 1 ORDER BY value_aud DESC`, [uid]),
    q(`SELECT COALESCE(method,'none') AS method, COUNT(*)::int AS lines,
              COALESCE(SUM(total_value_aud),0) AS value_aud
         FROM portfolio WHERE user_id = $1 GROUP BY 1 ORDER BY value_aud DESC`, [uid]),
    q(`SELECT CASE
                WHEN unit_value_aud < 5 THEN 'under 5'
                WHEN unit_value_aud < 25 THEN '5-25'
                WHEN unit_value_aud < 100 THEN '25-100'
                WHEN unit_value_aud < 500 THEN '100-500'
                WHEN unit_value_aud < 2000 THEN '500-2k'
                ELSE '2k+' END AS band,
              COUNT(*)::int AS lines, COALESCE(SUM(total_value_aud),0) AS value_aud
         FROM portfolio WHERE user_id = $1 GROUP BY 1`, [uid]),
    q(`SELECT date_trunc('week', sold_at)::date AS week,
              COALESCE(SUM(net_aud),0) AS net_aud, COUNT(*)::int AS n
         FROM sales WHERE user_id = $1 AND sold_at > now() - interval '26 weeks'
        GROUP BY 1 ORDER BY 1`, [uid]),
    q(`SELECT d.sku_id, d.player, d.section, d.card_number, v.trend_30d_pct,
              v.fair_value_aud, v.n_comps
         FROM latest_valuation v JOIN sku_detail d ON d.sku_id = v.sku_id
        WHERE v.marketplace_code IS NULL AND v.n_comps >= 3 AND v.trend_30d_pct IS NOT NULL
        ORDER BY ABS(v.trend_30d_pct) DESC LIMIT 12`),
    q(`SELECT card_type, COUNT(*)::int AS lines, COALESCE(SUM(qty),0)::int AS cards,
              COALESCE(SUM(total_value_aud),0) AS value_aud
         FROM portfolio WHERE user_id = $1 GROUP BY 1 ORDER BY value_aud DESC`, [uid]),
    q(`SELECT COALESCE(box_name,'not recorded') AS box, box_channel,
              COUNT(*)::int AS lines, COALESCE(SUM(total_value_aud),0) AS value_aud,
              COALESCE(SUM(cost_basis_aud * qty),0) AS cost_aud
         FROM portfolio WHERE user_id = $1 GROUP BY 1,2 ORDER BY value_aud DESC`, [uid]),
  ]);
  return redact({ totals, bySection, byAction, coverage, valueBands, recentSales, topMovers,
                  byType, byBox, owner: v.target.username, isSelf: v.isSelf }, v.isSelf);
});

app.get('/api/facets', async () => {
  const [sections, teams, products, positions, clubs] = await Promise.all([
    q(`SELECT product_code, section, COUNT(*)::int AS n FROM cards GROUP BY 1,2 ORDER BY 1,2`),
    q(`SELECT team, COUNT(*)::int AS n FROM cards WHERE team IS NOT NULL AND team <> '' GROUP BY 1 ORDER BY 1`),
    q(`SELECT code, name FROM products ORDER BY code`),
    // Counted in SKUs, not cards, because the gallery renders one tile per SKU: a
    // filter that promises 31 and then shows 32 tiles is worse than no count at all.
    q(`SELECT p.position, COUNT(DISTINCT s.id)::int AS n, COUNT(DISTINCT p.name)::int AS players
         FROM players p JOIN cards c ON c.player = p.name JOIN skus s ON s.card_id = c.id
        WHERE p.position IS NOT NULL GROUP BY 1 ORDER BY 2 DESC`),
    q(`SELECT p.club, COUNT(DISTINCT s.id)::int AS n, COUNT(DISTINCT p.name)::int AS players
         FROM players p JOIN cards c ON c.player = p.name JOIN skus s ON s.card_id = c.id
        WHERE p.club IS NOT NULL GROUP BY 1 ORDER BY 2 DESC, 1`),
  ]);
  return { sections, teams, products, positions, clubs };
});

// ---------------------------------------------------------------------------
// Portfolio
// ---------------------------------------------------------------------------

app.get('/api/portfolio', async (req, reply) => {
  const v = await viewTarget(req, reply);
  if (!v) return;
  const [rows, totals] = await Promise.all([
    q(`SELECT * FROM portfolio WHERE user_id = $1 ORDER BY total_value_aud DESC NULLS LAST`,
      [v.target.id]),
    one(`SELECT COUNT(*)::int AS lines, COALESCE(SUM(qty),0)::int AS cards,
                COALESCE(SUM(total_value_aud),0) AS value_aud,
                COALESCE(SUM(cost_basis_aud * qty),0) AS cost_aud,
                COUNT(*) FILTER (WHERE n_comps > 0)::int AS priced_from_comps
           FROM portfolio WHERE user_id = $1`, [v.target.id]),
  ]);
  return redact({ rows, totals, owner: v.target.username,
                  ownerDisplay: v.target.display_name, isSelf: v.isSelf }, v.isSelf);
});

const HoldingBody = z.object({
  skuId: z.coerce.number().optional(),
  cardId: z.coerce.number().optional(),
  qty: z.coerce.number().int().default(1),
  costBasisAud: z.coerce.number().optional(),
  acquiredAt: z.string().optional(),
  priceOverrideAud: z.coerce.number().nullable().optional(),
  notes: z.string().optional(),
});

app.post('/api/holdings', async (req, reply) => {
  const me = requireUser(req, reply);
  if (!me) return;
  const b = HoldingBody.parse(req.body);
  const skuId = b.skuId ?? (b.cardId ? await baseSkuFor(b.cardId) : null);
  if (!skuId) return { error: 'skuId or cardId required' };

  if (b.qty <= 0) {
    await q(`DELETE FROM holdings WHERE sku_id = $1 AND user_id = $2`, [skuId, me.id]);
    return { ok: true, removed: true };
  }
  const row = await one(
    `INSERT INTO holdings (user_id, sku_id, qty, cost_basis_aud, acquired_at, price_override_aud, notes)
     VALUES ($7,$1,$2,$3,$4,$5,$6)
     ON CONFLICT (user_id, sku_id) DO UPDATE SET qty = EXCLUDED.qty,
       cost_basis_aud = COALESCE(EXCLUDED.cost_basis_aud, holdings.cost_basis_aud),
       acquired_at = COALESCE(EXCLUDED.acquired_at, holdings.acquired_at),
       price_override_aud = EXCLUDED.price_override_aud,
       notes = COALESCE(EXCLUDED.notes, holdings.notes),
       updated_at = now()
     RETURNING *`,
    [skuId, b.qty, b.costBasisAud ?? null, b.acquiredAt ?? null, b.priceOverrideAud ?? null,
     b.notes ?? null, me.id],
  );
  return { ok: true, holding: row };
});

const SaleBody = z.object({
  skuId: z.coerce.number(),
  qty: z.coerce.number().int().default(1),
  priceEach: z.coerce.number(),
  currency: z.string().default('AUD'),
  marketplaceCode: z.string().optional(),
  communityId: z.coerce.number().optional(),
  feesAud: z.coerce.number().optional(),
  shippingAud: z.coerce.number().optional(),
  soldAt: z.string().optional(),
  notes: z.string().optional(),
});

app.post('/api/sales', async (req, reply) => {
  const me = requireUser(req, reply);
  if (!me) return;
  const b = SaleBody.parse(req.body);
  const { toAud } = await import('./valuation/fx.js');
  const rate = await toAud(b.currency);
  const eachAud = Math.round(b.priceEach * rate * 100) / 100;

  // Model the fees if the caller didn't supply them.
  let fees = b.feesAud;
  if (fees == null && b.marketplaceCode) {
    const [m] = await marketplaceEcon([b.marketplaceCode]);
    if (m) fees = (await netProceeds(m, eachAud * b.qty)).feesAud;
  }
  const net = Math.round((eachAud * b.qty - (fees ?? 0) - (b.shippingAud ?? 0)) * 100) / 100;

  const sale = await one(
    `INSERT INTO sales (user_id, sku_id, qty, price_each, currency, price_each_aud, marketplace_code,
                        community_id, fees_aud, shipping_aud, net_aud, sold_at, notes)
     VALUES ($13,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,COALESCE($11::timestamptz, now()),$12) RETURNING *`,
    [b.skuId, b.qty, b.priceEach, b.currency.toUpperCase(), eachAud, b.marketplaceCode ?? null,
     b.communityId ?? null, fees ?? 0, b.shippingAud ?? 0, net, b.soldAt ?? null, b.notes ?? null,
     me.id],
  );
  // Decrement YOUR copy. Without the user predicate, recording a sale would take the card off
  // whoever's row the database found first.
  await q(`UPDATE holdings SET qty = GREATEST(0, qty - $2), updated_at = now()
            WHERE sku_id = $1 AND user_id = $3`, [b.skuId, b.qty, me.id]);
  await q(`DELETE FROM holdings WHERE sku_id = $1 AND user_id = $2 AND qty <= 0`, [b.skuId, me.id]);
  return { ok: true, sale };
});

app.get('/api/sales', async (req, reply) => {
  const v = await viewTarget(req, reply);
  if (!v) return;
  const [rows, totals] = await Promise.all([
    q(`SELECT s.*, d.label, d.player, m.name AS marketplace_name, c.name AS community_name
         FROM sales s
         JOIN sku_detail d ON d.sku_id = s.sku_id
         LEFT JOIN marketplaces m ON m.code = s.marketplace_code
         LEFT JOIN communities c ON c.id = s.community_id
        WHERE s.user_id = $1
        ORDER BY s.sold_at DESC LIMIT 500`, [v.target.id]),
    one(`SELECT COUNT(*)::int AS n, COALESCE(SUM(qty),0)::int AS cards,
                COALESCE(SUM(price_each_aud * qty),0) AS gross_aud,
                COALESCE(SUM(fees_aud),0) AS fees_aud,
                COALESCE(SUM(net_aud),0) AS net_aud FROM sales WHERE user_id = $1`, [v.target.id]),
  ]);
  return redact({ rows, totals, owner: v.target.username, isSelf: v.isSelf }, v.isSelf);
});

app.delete('/api/sales/:id', async (req, reply) => {
  const me = requireUser(req, reply);
  if (!me) return;
  const { id } = req.params as any;
  // `AND user_id` is the authorisation check, not an optimisation: deleting by bare row id
  // would let anyone undo anyone's sale and credit the card back to their own collection.
  const s = await one<{ sku_id: number; qty: number }>(
    `DELETE FROM sales WHERE id = $1 AND user_id = $2 RETURNING sku_id, qty`, [id, me.id]);
  if (!s) return reply.code(404).send({ error: 'no such sale of yours' });
  await q(
    `INSERT INTO holdings (user_id, sku_id, qty) VALUES ($3,$1,$2)
       ON CONFLICT (user_id, sku_id) DO UPDATE SET qty = holdings.qty + EXCLUDED.qty, updated_at = now()`,
    [s.sku_id, s.qty, me.id],
  );
  return { ok: true, restored: s };
});

// ---------------------------------------------------------------------------
// Valuation & recommendations
// ---------------------------------------------------------------------------

app.post('/api/revalue', async (req) => {
  const { skuId, onlyHeld } = (req.body ?? {}) as any;
  if (skuId) {
    const v = await valueSku({ skuId: Number(skuId), marketplaceCode: null });
    if (v) await saveValuation(v);
    await computeVelocity(Number(skuId), null, 30);
    return { ok: true, valuation: v };
  }
  await enqueue('revalue', { onlyHeld: !!onlyHeld });
  return { ok: true, queued: 'revalue' };
});

app.get('/api/recommendations', async (req, reply) => {
  const v = await viewTarget(req, reply);
  if (!v) return;
  const { limit = '100', action } = req.query as any;
  const args: any[] = [v.target.id];
  let where = 'h.qty > 0 AND h.user_id = $1';
  if (action) { args.push(action); where += ` AND r.action = $${args.length}`; }
  args.push(Math.min(Number(limit) || 100, 500));
  return q(
    `SELECT r.*, d.label, d.player, d.team, d.section, d.card_number, d.parallel_name,
            d.grader, d.grade, h.qty, v.fair_value_aud, v.n_comps, v.confidence
       FROM latest_recommendation r
       JOIN sku_detail d ON d.sku_id = r.sku_id
       JOIN holdings h ON h.sku_id = r.sku_id
       LEFT JOIN latest_valuation v ON v.sku_id = r.sku_id AND v.marketplace_code IS NULL
      WHERE ${where}
      ORDER BY r.score DESC NULLS LAST
      LIMIT $${args.length}`,
    args,
  ).then((rows) => redact(rows, v.isSelf));
});

app.post('/api/recommend', async (req) => {
  const { skuId, useAi } = (req.body ?? {}) as any;
  if (skuId) return { ok: true, recommendation: await recommendSku(Number(skuId), { useAi }) };
  await enqueue('recommend', { useAi: useAi !== false });
  return { ok: true, queued: 'recommend' };
});

/** Ad-hoc "what would I net selling this for X, where?" — no persistence. */
app.get('/api/where-to-sell', async (req) => {
  const { grossAud, skuId, useAds } = req.query as any;
  const gross = Number(grossAud);
  if (!Number.isFinite(gross) || gross <= 0) return { error: 'grossAud required' };

  let team: string | null = null, player = '', section = '';
  if (skuId) {
    const d = await one<any>(`SELECT player, team, section FROM sku_detail WHERE sku_id = $1`, [skuId]);
    if (d) { team = d.team; player = d.player; section = d.section; }
  }
  const { rankVenues } = await import('./recommend/venue.js');
  const ladder = await rankVenues({
    skuId: Number(skuId) || -1, globalValueAud: gross, team, player, section,
    useAds: useAds === 'true',
  });
  return { grossAud: gross, ladder };
});

app.get('/api/marketplaces', async () => marketplaceEcon());
app.get('/api/communities', async () => q(`SELECT * FROM communities WHERE active ORDER BY name`));

// ---------------------------------------------------------------------------
// Ingestion
// ---------------------------------------------------------------------------

app.post('/api/ingest', async (req) => {
  const { mode = 'hot', limit, cardIds, sync } = (req.body ?? {}) as any;
  if (sync) return runIngest({ mode, limit, cardIds });
  await enqueue('ingest', { mode, limit, cardIds });
  return { ok: true, queued: 'ingest', mode };
});

app.post('/api/fx/refresh', async () => ({ ok: true, pairs: await refreshFx() }));

app.post('/api/import/comps-csv', async (req) => {
  const { csv } = (req.body ?? {}) as any;
  if (typeof csv !== 'string') return { error: 'body.csv (string) required' };
  return importCompsCsv(csv);
});

app.post('/api/import/holdings-csv', async (req) => {
  const { csv } = (req.body ?? {}) as any;
  if (typeof csv !== 'string') return { error: 'body.csv (string) required' };
  return importHoldingsCsv(csv);
});

/** Import a save file from the original HTML tracker. */
app.post('/api/import/legacy-json', async (req) => {
  const body = (req.body ?? {}) as any;
  return importLegacyJson(body.data ?? body);
});


// ---------------------------------------------------------------------------
// Building your collection
// ---------------------------------------------------------------------------

const AddBody = z.object({
  skuId: z.coerce.number().optional(),
  cardId: z.coerce.number().optional(),
  legacyId: z.string().optional(),
  parallelName: z.string().nullish(),
  printRun: z.coerce.number().nullish(),
  grader: z.string().nullish(),
  grade: z.coerce.number().nullish(),
  qty: z.coerce.number().default(1),
  costBasisAud: z.coerce.number().nullish(),
  acquiredAt: z.string().nullish(),
  boxId: z.coerce.number().nullish(),
  acquiredFrom: z.string().nullish(),
  condition: z.string().nullish(),
  priceOverrideAud: z.coerce.number().nullish(),
  notes: z.string().nullish(),
  /** optional own photo, as a data URL */
  photo: z.string().nullish(),
});

/**
 * Add a card to the collection. Handles the version too: naming a parallel or a
 * grade that has never been recorded creates it, so you are never blocked from
 * entering a card you actually own.
 */
/**
 * Bulk entry, step one: parse and match, write nothing.
 *
 * Split from the commit deliberately. The matcher is right the overwhelming majority of the
 * time, which is excellent for pricing — a wrong comp gets excluded and the median absorbs
 * it — and unacceptable for data entry, where a wrong holding is silent, permanent, and
 * quietly corrupts every number downstream. So the human sees what matched, at what
 * confidence, with alternatives, and confirms.
 */
app.post('/api/collection/parse', async (req) => {
  const b = z.object({
    text: z.string().max(200_000),
    allowLlm: z.boolean().optional(),
  }).parse(req.body ?? {});
  return parseQuickAdd(b.text, { allowLlm: b.allowLlm });
});

/**
 * Bulk entry, step two: commit the confirmed rows.
 *
 * Takes explicit sku ids rather than re-matching, so what gets written is exactly what was
 * reviewed on screen — re-running the matcher here would mean the confirmation was of one
 * thing and the write another.
 */
app.post('/api/collection/bulk', async (req, reply) => {
  const me = requireUser(req, reply);
  if (!me) return;
  // Two shapes, because two things can be confirmed. `skuId` is "this exact SKU exists and
  // is the one" — the ordinary case. `cardId` plus a parallel is "the card is right and the
  // parallel is not on the checklist", which addHolding handles by declaring it. Refusing
  // the second shape would mean bulk entry could record base cards and not the /49s.
  const b = z.object({
    rows: z.array(z.object({
      skuId: z.coerce.number().optional(),
      cardId: z.coerce.number().optional(),
      parallelName: z.string().max(80).nullable().optional(),
      printRun: z.coerce.number().int().min(1).max(100000).nullable().optional(),
      grader: z.string().max(12).nullable().optional(),
      grade: z.coerce.number().min(1).max(10).nullable().optional(),
      qty: z.coerce.number().min(1).max(999).default(1),
      costBasisAud: z.coerce.number().nullable().optional(),
      notes: z.string().max(500).nullable().optional(),
    }).refine((r) => r.skuId != null || r.cardId != null,
              { message: 'each row needs a skuId or a cardId' })).max(2000),
  }).parse(req.body ?? {});

  const added: number[] = [];
  const errors: Array<{ skuId: number | null; cardId?: number | null; error: string }> = [];
  for (const r of b.rows) {
    try {
      const res = await addHolding({
        userId: me.id,
        skuId: r.skuId, cardId: r.cardId,
        parallelName: r.parallelName ?? undefined,
        printRun: r.printRun ?? undefined,
        grader: r.grader ?? undefined,
        grade: r.grade ?? undefined,
        qty: r.qty,
        costBasisAud: r.costBasisAud ?? undefined,
        notes: r.notes ?? undefined,
      } as any);
      // The SKU may have just been created, so trust what addHolding resolved rather than
      // what was sent — otherwise the valuation pass below prices nothing.
      if (res.skuId) added.push(res.skuId);
    } catch (e: any) {
      errors.push({ skuId: r.skuId ?? null, cardId: r.cardId ?? null, error: e.message });
    }
  }

  // Price what just landed, so the collection view is not full of blank lines. Sequential
  // rather than parallel: a 200-card paste firing 200 concurrent valuations is how you
  // exhaust the connection pool on the machine you are typing into.
  let priced = 0;
  for (const skuId of added) {
    try {
      const v = await valueSku({ skuId, marketplaceCode: null });
      if (v) { await saveValuation(v); priced++; }
    } catch { /* a valuation failure must not lose the holding */ }
  }
  return { added: added.length, priced, errors };
});

app.post('/api/collection/add', async (req, reply) => {
  const me = requireUser(req, reply);
  if (!me) return;
  const b = AddBody.parse(req.body);
  const res = await addHolding({ ...b, userId: me.id });
  // A photo attached while adding the card is the FRONT of your copy, filed under you —
  // not the shared SKU picture it used to become.
  if (b.photo && res.skuId) {
    try {
      await savePhoto({ userId: Number(me.id), username: me.username, skuId: res.skuId,
                        side: 'front', dataUrl: b.photo, cropped: !!(b as any).photoCropped });
    } catch (e: any) { return { ...res, photoError: e.message }; }
  }
  // Price it immediately so the new line isn't blank in the UI.
  if (res.skuId) {
    const v = await valueSku({ skuId: res.skuId, marketplaceCode: null });
    if (v) await saveValuation(v);
  }
  return res;
});

// ---------------------------------------------------------------------------
// Quick add
//
// The rhythm from the old HTML tracker, kept exactly: pick the set, pick the section, type
// the number off the front of the card, Enter. It is the fastest way anyone has found to get
// a physical pile into a database, because it is the only information you can read off a card
// without thinking — and the checklist supplies the rest.
//
// What is different here is where it lands. The tracker wrote to that browser's local
// storage: one pile per browser, invisible from the phone, gone if the cache is cleared. This
// writes to the shared database under whoever is signed in, so the same pile is on the laptop,
// on the phone, and in the backup.
// ---------------------------------------------------------------------------

/**
 * Everything the Quick add bar needs to populate its dropdowns, in ONE request.
 *
 * One request rather than three chained ones because the section list depends on the set and
 * the parallel list depends on both — done lazily that would be two round trips between
 * choosing a set and being able to type a number, on a phone, on home wifi. The whole payload
 * is a few kilobytes and it changes only when a migration runs.
 */
app.get('/api/quickadd/options', async (req, reply) => {
  if (!requireUser(req, reply)) return;
  const [products, sections, parallels] = await Promise.all([
    q<any>(`SELECT code, name FROM products WHERE code <> 'X' ORDER BY code`),
    // `MIN(card_number)`/`MAX(card_number)` would be wrong, and wrong in a way that reads as
    // plausible: card_number is TEXT (real sets contain 'RR-12', 'A1'), so MIN/MAX compare
    // lexicographically and a 300-card set reports its range as "1 to 99". Sorting by length
    // first gives natural numeric order for the numeric ones and stays sane for the rest.
    q<any>(`SELECT product_code, section, COUNT(*)::int AS cards,
                   (array_agg(card_number ORDER BY length(card_number), card_number))[1]
                     AS first_number,
                   (array_agg(card_number ORDER BY length(card_number) DESC, card_number DESC))[1]
                     AS last_number
              FROM cards WHERE NOT is_custom
             GROUP BY 1, 2 ORDER BY 1, 2`),
    q<any>(`SELECT product_code, section, name, print_run
              FROM parallels
             ORDER BY product_code, section,
                      -- rarest last, unnumbered first: the list reads as a ladder, and the
                      -- one you are most likely to have pulled is nearest the top.
                      (print_run IS NOT NULL), print_run DESC NULLS FIRST, name`),
  ]);
  return { products, sections, parallels };
});

const QuickAddBody = z.object({
  productCode: z.string().min(1),
  section: z.string().min(1),
  cardNumber: z.string().min(1),
  parallelName: z.string().nullish(),
  printRun: z.coerce.number().nullish(),
  grader: z.string().nullish(),
  grade: z.coerce.number().nullish(),
  qty: z.coerce.number().default(1),
  costBasisAud: z.coerce.number().nullish(),
  notes: z.string().nullish(),
});

/**
 * Add one card by its number, the way you would read it off the card.
 *
 * Returns the SKU and its label so the caller can put the camera buttons on screen
 * immediately — photographing is the step right after logging, and making somebody search for
 * the card they just typed in is how a hundred-card session becomes a two-hour one.
 */
app.post('/api/quickadd', async (req, reply) => {
  const me = requireUser(req, reply);
  if (!me) return;
  const b = QuickAddBody.parse(req.body);

  // Card numbers are text, not integers - "154", "RR-12", "A1" all occur - but people type
  // `007` off a card printed `7`, and a leading-zero miss reads as "that card doesn't exist".
  const typed = b.cardNumber.trim().toUpperCase();
  const stripped = typed.replace(/^0+(?=\d)/, '');

  const card = await one<any>(
    `SELECT id, player, team, card_number, section, product_code
       FROM cards
      WHERE product_code = $1 AND section = $2
        AND upper(card_number) IN ($3, $4)
      LIMIT 1`,
    [b.productCode, b.section, typed, stripped],
  );

  if (!card) {
    // Say which numbers DO exist in that section. "not found" alone leaves you wondering
    // whether you mistyped, picked the wrong section, or own something off-checklist.
    // Same length-first ordering as /api/quickadd/options — see the note there. A hint that
    // says "it runs 1-99" for a 300-card set sends you looking for a problem with your card.
    const range = await one<any>(
      `SELECT (array_agg(card_number ORDER BY length(card_number), card_number))[1] AS lo,
              (array_agg(card_number ORDER BY length(card_number) DESC, card_number DESC))[1] AS hi,
              COUNT(*)::int AS n
         FROM cards WHERE product_code = $1 AND section = $2`,
      [b.productCode, b.section],
    );
    return reply.code(404).send({
      error: range?.n
        ? `No #${typed} in that section. It runs ${range.lo}-${range.hi} (${range.n} cards).`
        : `That section has no cards loaded.`,
      notFound: true,
    });
  }

  const res = await addHolding({
    userId: me.id,
    cardId: Number(card.id),
    parallelName: b.parallelName || null,
    printRun: b.printRun ?? null,
    grader: b.grader || null,
    grade: b.grade ?? null,
    qty: b.qty,
    costBasisAud: b.costBasisAud ?? null,
    notes: b.notes || null,
  });

  if (res.skuId) {
    try {
      const v = await valueSku({ skuId: res.skuId, marketplaceCode: null });
      if (v) await saveValuation(v);
    } catch { /* a valuation failure must never lose the card you just logged */ }
  }

  const detail = await one<any>(
    `SELECT sku_id, label, player, card_number, section, parallel_name, print_run,
            grader, grade, product_code
       FROM sku_detail WHERE sku_id = $1`,
    [res.skuId],
  );
  const held = await one<any>(
    `SELECT qty FROM holdings WHERE user_id = $1 AND sku_id = $2`, [me.id, res.skuId],
  );
  const photos = await listPhotos(Number(res.skuId), Number(me.id));

  return {
    ...res,
    detail,
    qtyOwned: Number(held?.qty ?? b.qty),
    photos: photos.filter((p) => p.mine),
  };
});

/**
 * Your collection as a CSV, photographs included.
 *
 * "Included" needs defining, because a CSV cannot contain a JPEG. Each row carries the
 * FILENAMES of its front and back photographs, relative to the photo folder — so the CSV and
 * the folder together are a complete, self-describing copy of your collection that opens in
 * Excel and does not need this app to be readable in ten years. That is the point of an
 * export: it is the thing you keep if the software goes away.
 *
 * Scoped to the signed-in person, and only ever to them. There is no `?user=` here even
 * though the portfolio has one, because an export is a bulk copy: the read-only screens strip
 * cost and profit column by column, and a CSV that quietly did the same would be a file
 * missing columns with no indication why.
 */
app.get('/api/export.csv', async (req, reply) => {
  const me = requireUser(req, reply);
  if (!me) return;

  const rows = await q<any>(
    `SELECT d.product_code, pr.name AS product_name, d.section, d.card_number, d.player,
            d.team, d.parallel_name, d.print_run, d.grader, d.grade,
            h.qty, h.cost_basis_aud, h.condition, h.acquired_at, h.acquired_from, h.notes,
            lv.fair_value_aud, lv.n_comps,
            (SELECT rel_path FROM card_photos
              WHERE user_id = h.user_id AND sku_id = h.sku_id AND side = 'front') AS photo_front,
            (SELECT rel_path FROM card_photos
              WHERE user_id = h.user_id AND sku_id = h.sku_id AND side = 'back')  AS photo_back
       FROM holdings h
       JOIN sku_detail d ON d.sku_id = h.sku_id
       LEFT JOIN products pr ON pr.code = d.product_code
       -- marketplace_code IS NULL is the OVERALL valuation. Without that condition this join
       -- fans out to one row per marketplace the moment per-venue valuations exist, and a CSV
       -- that silently lists your whole collection four times is an expensive thing to notice
       -- late. Every other view in the schema carries the same condition.
       -- (No backticks in here on purpose: this is a JS template literal, and a backtick in a
       --  SQL comment ends the string with a parse error 40 lines away from the cause.)
       LEFT JOIN latest_valuation lv
              ON lv.sku_id = h.sku_id AND lv.marketplace_code IS NULL
      WHERE h.user_id = $1
      ORDER BY d.product_code, d.section, length(d.card_number), d.card_number`,
    [me.id],
  );

  const headers = [
    'set_code', 'set_name', 'section', 'card_number', 'player', 'team',
    'parallel', 'print_run', 'grader', 'grade',
    'qty', 'paid_each_aud', 'est_value_each_aud', 'est_value_total_aud', 'comps_used',
    'condition', 'acquired_at', 'acquired_from', 'notes',
    'photo_front', 'photo_back',
  ];

  /**
   * RFC 4180 quoting, and one extra rule that is not in it.
   *
   * A field starting with `=`, `+`, `-` or `@` is executed as a FORMULA by Excel, Numbers and
   * Google Sheets when the file is opened. Player names do not start with those, but the
   * notes field is free text you typed, and "=cheap, cracked corner" is a plausible note that
   * would silently become a spreadsheet error - or, with a crafted note, something worse.
   * Prefixing an apostrophe makes it literal text; Excel does not display the apostrophe.
   */
  const cell = (v: any) => {
    if (v == null) return '';
    let s = String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };

  const lines = [headers.join(',')];
  for (const r of rows) {
    const each = r.fair_value_aud == null ? null : Number(r.fair_value_aud);
    lines.push([
      r.product_code, r.product_name, r.section, r.card_number, r.player, r.team,
      r.parallel_name, r.print_run, r.grader, r.grade,
      r.qty, r.cost_basis_aud,
      each, each == null ? null : (each * Number(r.qty)).toFixed(2), r.n_comps,
      r.condition, r.acquired_at, r.acquired_from, r.notes,
      r.photo_front, r.photo_back,
    ].map(cell).join(','));
  }

  const stamp = new Date().toISOString().slice(0, 10);
  return reply
    .header('Content-Type', 'text/csv; charset=utf-8')
    // The BOM is for Excel on Windows, which otherwise reads a UTF-8 CSV as the local
    // codepage and turns every accented player name into mojibake - Mbappé becomes MbappÃ©.
    // Every other tool ignores it.
    .header('Content-Disposition',
            `attachment; filename="cardvault-${me.username}-${stamp}.csv"`)
    .send('﻿' + lines.join('\r\n') + '\r\n');
});

/** Replace a line's fields outright, rather than incrementing quantity. */
app.put('/api/collection/:skuId', async (req, reply) => {
  const me = requireUser(req, reply);
  if (!me) return;
  const { skuId } = req.params as any;
  return setHolding(Number(skuId), { ...AddBody.parse(req.body ?? {}), userId: me.id });
});

app.delete('/api/collection/:skuId', async (req, reply) => {
  const me = requireUser(req, reply);
  if (!me) return;
  const { skuId } = req.params as any;
  await q(`DELETE FROM holdings WHERE sku_id = $1 AND user_id = $2`, [skuId, me.id]);
  return { ok: true };
});

/** Resolve (or create) a SKU without touching holdings — used by the add dialog. */
app.post('/api/skus/resolve', async (req) => {
  const b = AddBody.parse(req.body);
  const skuId = await resolveOrCreateSku(b);
  return { skuId, detail: await one(`SELECT * FROM sku_detail WHERE sku_id = $1`, [skuId]) };
});

const CustomBody = z.object({
  player: z.string().min(1),
  team: z.string().nullish(),
  cardNumber: z.string().nullish(),
  section: z.string().nullish(),
  productCode: z.string().nullish(),
  setName: z.string().nullish(),
  year: z.string().nullish(),
  isRookie: z.coerce.boolean().optional(),
  isAuto: z.coerce.boolean().optional(),
  seedEstAud: z.coerce.number().nullish(),
  notes: z.string().nullish(),
  // add it to the collection in the same call
  qty: z.coerce.number().optional(),
  costBasisAud: z.coerce.number().nullish(),
  boxId: z.coerce.number().nullish(),
  acquiredFrom: z.string().nullish(),
  parallelName: z.string().nullish(),
  grader: z.string().nullish(),
  grade: z.coerce.number().nullish(),
  photo: z.string().nullish(),
});

/**
 * Create a card the checklist doesn't have, and optionally add it to the
 * collection in the same request — which is what you actually want when you're
 * holding an unlisted card and typing it in.
 */
app.post('/api/cards/custom', async (req, reply) => {
  const me = requireUser(req, reply);
  if (!me) return;
  const b = CustomBody.parse(req.body);
  const created = await createCustomCard(b);

  let skuId = created.skuId;
  if (b.qty && b.qty > 0) {
    const added = await addHolding({
      userId: me.id,
      cardId: created.cardId, parallelName: b.parallelName, grader: b.grader, grade: b.grade,
      qty: b.qty, costBasisAud: b.costBasisAud, boxId: b.boxId, acquiredFrom: b.acquiredFrom,
    });
    skuId = added.skuId;
  }
  if (b.photo) {
    try {
      await savePhoto({ userId: Number(me.id), username: me.username, skuId,
                        side: 'front', dataUrl: b.photo, cropped: !!(b as any).photoCropped });
    } catch (e: any) { return { ...created, skuId, photoError: e.message }; }
  }
  const v = await valueSku({ skuId, marketplaceCode: null });
  if (v) await saveValuation(v);
  return { ...created, skuId };
});

app.delete('/api/cards/custom/:cardId', async (req) => {
  const { cardId } = req.params as any;
  return deleteCustomCard(Number(cardId));
});

// ---------------------------------------------------------------------------
// Photographs of the cards you own
//
// The rules, in one place:
//   * anyone signed in may LOOK at anyone's photographs — that is the sharing model, and
//     helping a friend identify a card is the reason the feature exists
//   * only the person who took a photograph may replace or delete it, checked against the
//     row's own user_id and never against anything the client sent
//   * files are served by photo id; no path from a request is ever opened
// ---------------------------------------------------------------------------

/**
 * Add or replace one side of your copy of a card.
 * Body: { photo: "data:image/jpeg;base64,...", side: "front" | "back", cropped?, width?, height? }
 */
app.post('/api/photos/:skuId', async (req, reply) => {
  const me = requireUser(req, reply);
  if (!me) return;
  const { skuId } = req.params as any;
  const b = (req.body ?? {}) as any;
  const photo = b.photo;
  const side = String(b.side ?? 'front').toLowerCase() as Side;

  if (typeof photo !== 'string' || photo.length < 32) {
    return reply.code(400).send({ error: 'body.photo (data URL) required' });
  }
  if (!SIDES.includes(side)) {
    return reply.code(400).send({ error: `side must be one of ${SIDES.join(', ')}` });
  }
  try {
    return await savePhoto({
      userId: Number(me.id), username: me.username, skuId: Number(skuId), side,
      dataUrl: photo, cropped: !!b.cropped,
      width: b.width == null ? null : Number(b.width),
      height: b.height == null ? null : Number(b.height),
    });
  } catch (e: any) {
    // These are all "the photo was wrong", not "the server broke": too big, not an image,
    // unknown card. A 500 here would send somebody looking in the logs for a bug that is
    // really a 12 MB HEIC.
    return reply.code(400).send({ error: e?.message ?? 'could not store that photo' });
  }
});

/** Every photograph of a card, whoever took it, mine first. */
app.get('/api/photos/:skuId', async (req, reply) => {
  const me = requireUser(req, reply);
  if (!me) return;
  const { skuId } = req.params as any;
  return { skuId: Number(skuId), photos: await listPhotos(Number(skuId), Number(me.id)) };
});

/** The image bytes. */
app.get('/api/photos/file/:photoId', async (req, reply) => {
  const me = requireUser(req, reply);
  if (!me) return;
  const found = await readPhoto(Number((req.params as any).photoId));
  if (!found) return reply.code(404).send({ error: 'not found' });
  return reply
    .header('Content-Type', found.mime)
    // `private` because these are photographs of one household's possessions behind a login,
    // and a shared cache in front of the tunnel must not hand them to the next visitor.
    .header('Cache-Control', 'private, max-age=300')
    .send(found.body);
});

app.delete('/api/photos/file/:photoId', async (req, reply) => {
  const me = requireUser(req, reply);
  if (!me) return;
  const res = await deletePhoto(Number((req.params as any).photoId), Number(me.id));
  if (res.missing) return reply.code(404).send({ error: 'not found' });
  if (res.notMine) {
    return reply.code(403).send({ error: 'that photo belongs to somebody else' });
  }
  return res;
});

/** How far through photographing your collection you are, and what it costs in disk. */
app.get('/api/photos', async (req, reply) => {
  const me = requireUser(req, reply);
  if (!me) return;
  const all = String((req.query as any)?.scope ?? '') === 'everyone';
  return photoStats(all ? null : Number(me.id));
});


// ---------------------------------------------------------------------------
// Players
//
// The collection reads better by person than by card: you own four Lamine Yamals
// across versions, and one tile with his face plus "4 cards · A$427" says more than
// four near-identical tiles.
// ---------------------------------------------------------------------------

const PlayerQuery = z.object({
  view: z.enum(['owned', 'all', 'hot']).default('owned'),
  search: z.string().optional(),
  team: z.string().optional(),
  position: z.string().optional(),
  club: z.string().optional(),
  sort: z.enum(['value', 'cards', 'name', 'trend']).default('value'),
  limit: z.coerce.number().max(600).default(200),
});

app.get('/api/players', async (req, reply) => {
  const v = await viewTarget(req, reply);
  if (!v) return;
  const p = PlayerQuery.parse(req.query);
  const args: any[] = [v.target.id];
  const having: string[] = [];
  const where: string[] = ["c.player <> ''"];

  if (p.search) { args.push(`%${p.search}%`); where.push(`(c.player ILIKE $${args.length} OR c.team ILIKE $${args.length})`); }
  if (p.team)   { args.push(p.team); where.push(`c.team = $${args.length}`); }
  // 'unknown' is a real choice, not an absence: most of the squad has no club on file
  // and hiding them behind an empty option makes the filter look broken.
  if (p.position) {
    if (p.position === 'unknown') where.push(`pl.position IS NULL`);
    else { args.push(p.position); where.push(`pl.position = $${args.length}`); }
  }
  if (p.club) {
    if (p.club === 'unknown') where.push(`pl.club IS NULL`);
    else { args.push(p.club); where.push(`pl.club = $${args.length}`); }
  }
  if (p.view === 'owned') having.push('SUM(COALESCE(h.qty,0)) > 0');
  if (p.view === 'hot')   having.push('BOOL_OR(c.hot)');

  const sortSql = {
    value: 'value_aud DESC NULLS LAST',
    cards: 'cards DESC, value_aud DESC NULLS LAST',
    name:  'player ASC',
    trend: 'trend_30d_pct DESC NULLS LAST',
  }[p.sort];

  args.push(p.limit);
  return q(
    `SELECT c.player,
            MIN(c.team)                                        AS team,
            BOOL_OR(c.hot)                                     AS hot,
            BOOL_OR(c.subset = 'RR' OR c.is_rookie)            AS is_rookie,
            COUNT(DISTINCT s.id) FILTER (WHERE h.qty > 0)::int  AS versions_owned,
            COALESCE(SUM(h.qty), 0)::int                        AS cards,
            COUNT(DISTINCT c.id)::int                           AS checklist_entries,
            COALESCE(SUM(COALESCE(h.price_override_aud, v.fair_value_aud, c.seed_est_aud) * h.qty), 0) AS value_aud,
            COALESCE(SUM(h.cost_basis_aud * h.qty), 0)          AS cost_aud,
            MAX(COALESCE(h.price_override_aud, v.fair_value_aud, c.seed_est_aud)) AS top_card_aud,
            AVG(v.trend_30d_pct)                                AS trend_30d_pct,
            SUM(v.n_comps)::int                                 AS n_comps,
            -- the most urgent action across everything you own of this player
            (ARRAY_AGG(r.action ORDER BY r.score DESC NULLS LAST)
              FILTER (WHERE r.action IS NOT NULL AND h.qty > 0))[1] AS action,
            SUM(r.best_net_aud) FILTER (WHERE h.qty > 0)        AS best_net_aud,
            pl.lookup_status                                    AS portrait_status,
            pl.author                                           AS portrait_author,
            pl.license                                          AS portrait_license,
            pl.credit_url                                       AS portrait_credit_url,
            pl.position                                         AS position,
            pl.position_source                                  AS position_source,
            pl.pose_override                                    AS pose_override,
            pl.club                                             AS club,
            pl.club_source                                       AS club_source,
            pl.club_resolution                                   AS club_resolution,
            pl.club_checked_at                                   AS club_checked_at,
            EXTRACT(DAY FROM now() - pl.club_checked_at)::int     AS club_age_days
       FROM cards c
       JOIN skus s ON s.card_id = c.id
       LEFT JOIN holdings h ON h.sku_id = s.id AND h.user_id = $1
       LEFT JOIN latest_valuation v ON v.sku_id = s.id AND v.marketplace_code IS NULL
       LEFT JOIN latest_recommendation r ON r.sku_id = s.id
       LEFT JOIN players pl ON pl.name = c.player
      WHERE ${where.join(' AND ')}
      GROUP BY c.player, pl.lookup_status, pl.author, pl.license, pl.credit_url,
               pl.position, pl.position_source, pl.pose_override, pl.club, pl.club_source,
               pl.club_resolution, pl.club_checked_at
      ${having.length ? 'HAVING ' + having.join(' AND ') : ''}
      ORDER BY ${sortSql}
      LIMIT $${args.length}`,
    args,
  );
});

/**
 * One player's page: who they are, what you own of them, and what the rest of the
 * checklist holds that you don't.
 */
app.get('/api/players/:name', async (req, reply) => {
  const v = await viewTarget(req, reply);
  if (!v) return;
  const name = decodeURIComponent((req.params as any).name);
  const uid = v.target.id;

  const [player, owned, missing, totals] = await Promise.all([
    one(`SELECT p.*, (SELECT MIN(team) FROM cards WHERE player = p.name) AS team,
                (SELECT BOOL_OR(hot) FROM cards WHERE player = p.name) AS hot,
                EXTRACT(DAY FROM now() - p.club_checked_at)::int AS club_age_days
           FROM players p WHERE p.name = $1`, [name]),

    q(`SELECT d.sku_id, d.label, d.player, d.team, d.section, d.card_number, d.subset,
              d.product_code, d.product_name, d.parallel_name, d.print_run, d.grader, d.grade,
              d.hot, d.card_type, d.variant_type, d.is_rookie, d.is_custom, d.found_in,
              d.image_source,
              h.qty AS owned_qty, h.cost_basis_aud, h.acquired_from, h.condition,
              bx.name AS box_name, bx.channel AS box_channel,
              COALESCE(h.price_override_aud, v.fair_value_aud, d.seed_est_aud) AS value_aud,
              v.n_comps, v.trend_30d_pct, v.method, v.confidence, v.low_aud, v.high_aud,
              r.action, r.best_marketplace_code, r.best_net_aud, r.score,
              (r.communities -> 0 ->> 'name') AS top_community,
              (SELECT json_agg(json_build_object('t', x.sold_at, 'v', x.price_aud) ORDER BY x.sold_at)
                 FROM (SELECT c2.sold_at, c2.price_aud FROM comps c2
                        WHERE c2.sku_id = d.sku_id AND NOT c2.excluded AND c2.is_sold
                        ORDER BY c2.sold_at DESC LIMIT 40) x) AS series
         FROM sku_detail d
         JOIN holdings h ON h.sku_id = d.sku_id AND h.qty > 0 AND h.user_id = $2
         LEFT JOIN product_boxes bx ON bx.id = h.box_id
         LEFT JOIN latest_valuation v ON v.sku_id = d.sku_id AND v.marketplace_code IS NULL
         LEFT JOIN latest_recommendation r ON r.sku_id = d.sku_id
        WHERE d.player = $1
        ORDER BY COALESCE(h.price_override_aud, v.fair_value_aud, d.seed_est_aud) DESC NULLS LAST`,
      [name, uid]),

    // What exists for this player that you don't have — the "chase list".
    q(`SELECT d.sku_id, d.player, d.section, d.card_number, d.product_code, d.product_name,
              d.card_type, d.variant_type, d.hot, d.subset, d.is_rookie, d.found_in,
              COALESCE(v.fair_value_aud, d.seed_est_aud) AS value_aud,
              v.n_comps, v.method
         FROM sku_detail d
         LEFT JOIN holdings h ON h.sku_id = d.sku_id AND h.user_id = $2
         LEFT JOIN latest_valuation v ON v.sku_id = d.sku_id AND v.marketplace_code IS NULL
        WHERE d.player = $1 AND (h.sku_id IS NULL OR h.qty = 0)
          AND d.parallel_name IS NULL AND d.grader IS NULL
        ORDER BY COALESCE(v.fair_value_aud, d.seed_est_aud) DESC NULLS LAST
        LIMIT 60`, [name, uid]),

    one(`SELECT COALESCE(SUM(total_value_aud),0) AS value_aud,
                COALESCE(SUM(cost_basis_aud * qty),0) AS cost_aud,
                COALESCE(SUM(qty),0)::int AS cards,
                COUNT(*)::int AS versions,
                COUNT(*) FILTER (WHERE n_comps > 0)::int AS comp_backed,
                COALESCE(SUM(best_net_aud),0) AS best_net_aud
           FROM portfolio WHERE player = $1 AND user_id = $2`, [name, uid]),
  ]);

  return { player: player ?? { name }, owned, missing, totals };
});

// --- portrait management ---------------------------------------------------

app.post('/api/players/backfill', async (req) => {
  const { limit, retryErrors } = (req.body ?? {}) as any;
  return backfillPortraits({ limit, retryErrors });
});

app.post('/api/players/:name/portrait', async (req) => {
  const name = decodeURIComponent((req.params as any).name);
  const b = (req.body ?? {}) as any;
  if (typeof b.photo === 'string' && b.photo.length > 32) {
    return setPortraitManually(name, b.photo, {
      author: b.author, license: b.license, licenseUrl: b.licenseUrl, creditUrl: b.creditUrl,
    });
  }
  // No file supplied: go and look one up.
  return resolvePlayer(name);
});

app.get('/api/players/portraits/status', async () => {
  const [byStatus, sample] = await Promise.all([
    q(`SELECT lookup_status, COUNT(*)::int AS n FROM players GROUP BY 1 ORDER BY n DESC`),
    q(`SELECT name, lookup_status, license, author, credit_url, lookup_note
         FROM players WHERE lookup_status <> 'pending' ORDER BY fetched_at DESC LIMIT 20`),
  ]);
  return { byStatus, sample };
});

// ---------------------------------------------------------------------------
// Boxes
// ---------------------------------------------------------------------------

app.get('/api/boxes', async (req, reply) => {
  const v = await viewTarget(req, reply);
  if (!v) return;
  const { product } = req.query as any;
  const args: any[] = [v.target.id];
  let where = '1=1';
  if (product) { args.push(product); where = `b.product_code = $${args.length}`; }
  return q(
    `SELECT b.*, p.name AS product_name,
            (SELECT COUNT(*)::int FROM holdings h WHERE h.box_id = b.id AND h.user_id = $1) AS your_lines
       FROM product_boxes b JOIN products p ON p.code = b.product_code
      WHERE ${where}
      ORDER BY b.product_code, b.sort_order`,
    args,
  );
});

/** What a given section comes out of — the "which box is this from" answer. */
app.get('/api/boxes/for-section', async (req) => {
  const { product, section } = req.query as any;
  if (!product || !section) return { error: 'product and section required' };
  return q(
    `SELECT b.name AS box, b.channel, b.packs_per_box, b.cards_per_pack, b.cards_per_box,
            b.guaranteed, b.verified, bc.availability, bc.odds, bc.note
       FROM box_contents bc JOIN product_boxes b ON b.id = bc.box_id
      WHERE b.product_code = $1 AND (bc.section IS NULL OR bc.section = $2)
      ORDER BY CASE bc.availability WHEN 'exclusive' THEN 0
                                    WHEN 'reported_exclusive' THEN 1 ELSE 2 END,
               b.sort_order`,
    [product, section],
  );
});

app.get('/api/sections', async (req) => {
  const { product } = req.query as any;
  const args: any[] = [];
  let where = 'NOT is_custom';
  if (product) { args.push(product); where += ` AND product_code = $${args.length}`; }
  return q(
    `SELECT product_code, section, COUNT(*)::int AS cards,
            MIN(card_number) AS first_number, MAX(card_number) AS last_number
       FROM cards WHERE ${where} GROUP BY 1,2 ORDER BY 1,2`,
    args,
  );
});

/** Parallels available for a section — populates the add dialog's dropdown. */
app.get('/api/parallels', async (req) => {
  const { product, section } = req.query as any;
  const args: any[] = [];
  const parts: string[] = ['1=1'];
  if (product) { args.push(product); parts.push(`product_code = $${args.length}`); }
  if (section) { args.push(section); parts.push(`section = $${args.length}`); }
  return q(
    `SELECT id, product_code, section, name, print_run FROM parallels
      WHERE ${parts.join(' AND ')}
      ORDER BY print_run NULLS FIRST, name`,
    args,
  );
});

// ---------------------------------------------------------------------------
// AI
// ---------------------------------------------------------------------------

app.post('/api/ask', async (req, reply) => {
  const me = requireUser(req, reply);
  if (!me) return;
  const { question } = (req.body ?? {}) as any;
  if (typeof question !== 'string' || question.length < 3) return { error: 'question required' };
  // Always the asker, never `?user=` — a natural-language question is not a place to widen
  // scope, because nobody reviews the SQL it turns into.
  return ask(question, { userId: me.id });
});

app.get('/api/ai/usage', async () => {
  const rows = await q(
    `SELECT date_trunc('day', asked_at) AS day, model,
            COUNT(*)::int AS calls, SUM(tokens_in)::int AS tokens_in, SUM(tokens_out)::int AS tokens_out,
            COUNT(*) FILTER (WHERE error IS NOT NULL)::int AS errors
       FROM ai_queries WHERE asked_at > now() - interval '30 days'
      GROUP BY 1,2 ORDER BY 1 DESC`,
  );
  return { budgetUsd: cfg.AI_MONTHLY_BUDGET_USD, daily: rows };
});

// ---------------------------------------------------------------------------
// Alerts
// ---------------------------------------------------------------------------

app.get('/api/alerts', async (req, reply) => {
  const me = requireUser(req, reply);
  if (!me) return;
  // Yours, plus the ownerless ones — a source failing is everybody's problem, a card moving
  // is only the holder's.
  return q(`SELECT a.*, d.label FROM alerts a LEFT JOIN sku_detail d ON d.sku_id = a.sku_id
             WHERE a.user_id = $1 OR a.user_id IS NULL
             ORDER BY a.fired_at DESC LIMIT 200`, [me.id]);
});

app.post('/api/watchlist', async (req, reply) => {
  const me = requireUser(req, reply);
  if (!me) return;
  const { skuId, query, rule, channel, target } = (req.body ?? {}) as any;
  const row = await one(
    `INSERT INTO watchlist (user_id, sku_id, query, rule, channel, target)
     VALUES ($6,$1,$2,$3,$4,$5) RETURNING *`,
    [skuId ?? null, query ?? null, JSON.stringify(rule ?? { type: 'price_drop', pct: 15 }),
     channel ?? 'log', target ?? null, me.id],
  );
  return { ok: true, watch: row };
});

// ---------------------------------------------------------------------------

const port = Number(cfg.PORT);
await app.listen({ port, host: '0.0.0.0' });
log.info({ port, capabilities: capabilities() }, 'CardVault API listening');
