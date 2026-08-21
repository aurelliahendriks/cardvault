import { cfg, hasAI } from '../config.js';
import { q, readOnlyQuery } from '../db.js';
import { log } from '../logger.js';
import { callAi, extractJson } from './client.js';

/**
 * Natural-language questions over your own collection.
 *
 * The model writes SQL; it does not get to run it. Three independent layers
 * stand between a generated string and the database:
 *   1. a whitelist of readable relations, injected as the only schema the model sees
 *   2. a static guard that rejects anything that isn't a single bare SELECT
 *   3. a READ ONLY transaction with a statement timeout, on a pool that could
 *      further be given a read-only role
 * Any one of these failing is survivable. All three failing is not a prompt
 * injection problem, it's a Postgres bug.
 */

/**
 * What generated SQL may read.
 *
 * The owned tables are deliberately absent. `holdings`, `sales`, `watchlist` and `portfolio`
 * are unfiltered across all users, and the guard below only checks *which* relations a query
 * touches — never what it filters on. So `SELECT SUM(total_value_aud) FROM portfolio` is a
 * perfectly well-formed query that reads everybody's collection, including cost basis, and no
 * amount of prompt instruction reliably prevents a model from writing it.
 *
 * The `my_*` views replace them. They filter on a session GUC set by the application inside
 * the same read-only transaction, so the scope is a property of the rows rather than of the
 * query — see `readOnlyQuery`.
 */
const READABLE = [
  'cards', 'products', 'parallels', 'skus', 'sku_detail', 'marketplaces',
  'comps', 'listings', 'valuations', 'latest_valuation', 'velocity',
  'recommendations', 'latest_recommendation', 'communities',
  'my_holdings', 'my_sales', 'my_portfolio', 'my_watchlist',
  // Photographs, scoped the same way. `card_photo_index` — the unscoped view that the app
  // uses to show you a friend's photo — is deliberately NOT here. Nothing about it would
  // leak money, but the whitelist is the tenancy boundary and a boundary with one reasonable
  // exception in it is a boundary nobody can check at a glance.
  'my_card_photos',
  'fx_rates', 'source_runs', 'sources', 'alerts',
];

const SCHEMA_DOC = `
-- Core reference
products(code, name)                                    -- 'A'=Donruss Road to WC 25/26, 'B'=Panini WC 2026
cards(id, legacy_id, product_code, section, card_number, player, team, subset, hot, seed_est_aud)
   -- subset 'RR' = Rated Rookie. section examples: 'Base','Kaboom!','Signature Series','Night Moves'
parallels(id, product_code, section, name, print_run, is_numbered)
skus(id, card_id, parallel_id, grader, grade, label)    -- the tradeable unit; grader NULL = raw
sku_detail(sku_id, label, card_id, legacy_id, product_code, product_name, section, card_number,
           player, team, subset, hot, seed_est_aud, parallel_name, print_run, grader, grade)

-- Marketplaces & money (all *_aud columns are Australian dollars)
marketplaces(code, name, region, currency, fee_pct, fee_fixed, intl_fee_pct, ship_from_au_cost,
             ship_days_est, customs_risk, requires_local_entity, audience_note)
fx_rates(as_of, base, quote, rate)

-- Observed market data
listings(id, source_code, marketplace_code, external_id, title, url, price, currency, shipping,
         is_sold, sold_at, observed_at, bids, format)
comps(id, listing_id, sku_id, marketplace_code, sold_at, price_aud, price_usd, is_sold,
      match_method, match_confidence, excluded, exclude_reason)
   -- ALWAYS filter: WHERE NOT excluded AND is_sold  when you want real sale prices

-- Derived
valuations(sku_id, marketplace_code, as_of, n_comps, median_aud, fair_value_aud, low_aud, high_aud,
           trend_30d_pct, trend_90d_pct, volatility, method, confidence)
   -- marketplace_code IS NULL means the global blended valuation
latest_valuation(sku_id, marketplace_code, as_of, n_comps, fair_value_aud, median_aud, low_aud,
                 high_aud, trend_30d_pct, trend_90d_pct, volatility, method, confidence)
velocity(sku_id, marketplace_code, as_of, window_days, sales_count, active_listings,
         sell_through, sales_per_day, days_to_sell_est)
recommendations(sku_id, as_of, action, urgency, best_marketplace_code, best_net_aud,
                venue_ladder jsonb, communities jsonb, grade_ev jsonb, timing jsonb, score, reasoning)
   -- action: 'sell_now','sell_soon','hold','grade_then_sell','lot_it','keep_watching'
latest_recommendation(...same columns, one row per sku)
communities(id, name, kind, region, url, fee_pct, focus_sections, focus_teams, min_value_aud,
            max_value_aud, likes_lots, likes_graded, speed_score, price_realization, notes)

-- Your collection
my_holdings(id, sku_id, qty, cost_basis_aud, acquired_at, price_override_aud, notes)
   -- already scoped to the person asking; there is no unscoped holdings table you can read
my_sales(id, sku_id, qty, price_each_aud, marketplace_code, fees_aud, net_aud, sold_at, notes)
my_portfolio(holding_id, sku_id, label, player, team, section, product_name, card_number,
          parallel_name, grader, grade, qty, cost_basis_aud, unit_value_aud, total_value_aud,
          n_comps, trend_30d_pct, confidence, priced_at, action, best_marketplace_code,
          best_net_aud, score)
   -- my_portfolio is the convenient starting point for almost any "what do I own" question
my_card_photos(id, sku_id, side, bytes, mime, width, height, cropped, captured_at, sku_label)
   -- one row per photograph YOU took; side is 'front' or 'back'. Use it to answer
   -- "which of my cards still have no photo" by left-joining from my_portfolio.

-- Ops
sources(code, name, kind, gives_sold, trust_weight, enabled)
source_runs(id, source_code, marketplace_code, started_at, finished_at, status, query,
            items_seen, items_new, cost_units, error)
`;

const SYSTEM = `You write a single read-only Postgres SELECT to answer a question about a personal trading-card collection.

SCHEMA (this is the whole schema; nothing else exists):
${SCHEMA_DOC}

Hard rules:
- Output exactly one statement, and it must start with SELECT or WITH.
- No INSERT/UPDATE/DELETE/DROP/ALTER/CREATE/GRANT/TRUNCATE/COPY, no semicolons beyond the end,
  no comments, no set-returning admin functions, no pg_* or information_schema access.
- Always LIMIT to at most 200 rows.
- Money columns ending _aud are Australian dollars; do not convert them.
- When the question is about what the user OWNS, start from the "my_portfolio" view.
- When the question is about market prices, use latest_valuation joined to sku_detail.
- When counting real sales, filter comps with: NOT excluded AND is_sold.
- Prefer returning a few well-named columns over SELECT *.
- If the question cannot be answered from this schema, return sql: null and say why in "note".

Respond with JSON only:
{"sql": "<the query or null>", "note": "<one sentence on what the query does or why it can't be done>"}`;

const FORBIDDEN =
  /\b(insert|update|delete|drop|alter|create|grant|revoke|truncate|copy|vacuum|analyze|reindex|cluster|listen|notify|call|do|merge|lock|set\s+role|set\s+session|reset|prepare|execute|deallocate|begin|commit|rollback|savepoint|pg_sleep|pg_read_file|pg_ls_dir|dblink|lo_import|lo_export)\b/i;

export interface GuardResult { ok: boolean; reason?: string; sql?: string }

/** Static guard. Deliberately paranoid and deliberately dumb — it rejects, it never fixes. */
export function guardSql(raw: string): GuardResult {
  let sql = raw.trim().replace(/;\s*$/, '').trim();

  if (!sql) return { ok: false, reason: 'empty query' };
  if (sql.includes(';')) return { ok: false, reason: 'multiple statements are not allowed' };
  if (/--|\/\*|\*\//.test(sql)) return { ok: false, reason: 'comments are not allowed' };
  if (!/^\s*(select|with)\b/i.test(sql)) return { ok: false, reason: 'query must start with SELECT or WITH' };
  if (FORBIDDEN.test(sql)) return { ok: false, reason: 'query contains a forbidden keyword' };
  if (/\b(pg_catalog|information_schema|pg_[a-z_]+\s*\()/i.test(sql)) {
    return { ok: false, reason: 'system catalog access is not allowed' };
  }

  // Every referenced relation must be on the whitelist.
  const refs = [...sql.matchAll(/\b(?:from|join)\s+((?:"?[a-zA-Z_][a-zA-Z0-9_]*"?\.)?"?[a-zA-Z_][a-zA-Z0-9_]*"?)/gi)]
    .map((m) => m[1]!.replace(/"/g, '').split('.').pop()!.toLowerCase());
  for (const r of refs) {
    // CTE names defined in this query are fine
    const isCte = new RegExp(`\\b(with|,)\\s+${r}\\s+as\\s*\\(`, 'i').test(sql);
    if (!isCte && !READABLE.includes(r)) {
      return { ok: false, reason: `relation "${r}" is not readable` };
    }
  }

  if (!/\blimit\s+\d+/i.test(sql)) sql = `${sql} LIMIT 200`;
  else {
    // clamp an over-large limit rather than rejecting
    sql = sql.replace(/\blimit\s+(\d+)/i, (_m, n) => `LIMIT ${Math.min(Number(n), 200)}`);
  }

  return { ok: true, sql };
}

export interface AskResult {
  question: string;
  sql: string | null;
  rows: any[];
  rowCount: number;
  answer: string;
  note?: string;
  error?: string;
  ms: number;
}

export async function ask(question: string, opts: { userId?: number } = {}): Promise<AskResult> {
  const t0 = Date.now();

  if (!hasAI()) {
    return {
      question, sql: null, rows: [], rowCount: 0, ms: Date.now() - t0,
      answer: 'Natural-language search needs ANTHROPIC_API_KEY set. Everything else works without it — use the /api/portfolio and /api/recommendations endpoints, or the dashboard filters.',
      error: 'ai_disabled',
    };
  }

  // --- 1. generate ------------------------------------------------------
  const gen = await callAi({
    model: cfg.AI_MODEL,
    system: SYSTEM,
    user: question.slice(0, 1000),
    maxTokens: 900,
    temperature: 0,
    purpose: 'nl2sql',
  });
  if (!gen) {
    return { question, sql: null, rows: [], rowCount: 0, ms: Date.now() - t0,
             answer: 'The AI call failed or the monthly budget is exhausted.', error: 'ai_unavailable' };
  }

  const parsed = extractJson<{ sql: string | null; note?: string }>(gen.text);
  if (!parsed) {
    return { question, sql: null, rows: [], rowCount: 0, ms: Date.now() - t0,
             answer: 'Could not parse a query out of the model response.', error: 'parse_failed' };
  }
  if (!parsed.sql) {
    return { question, sql: null, rows: [], rowCount: 0, ms: Date.now() - t0,
             answer: parsed.note ?? 'That question cannot be answered from the collection data.', note: parsed.note };
  }

  // --- 2. guard ---------------------------------------------------------
  const guard = guardSql(parsed.sql);
  if (!guard.ok) {
    log.warn({ sql: parsed.sql, reason: guard.reason }, 'rejected model SQL');
    await q(`INSERT INTO ai_queries (question, generated_sql, error, model) VALUES ($1,$2,$3,$4)`,
      [question, parsed.sql, `guard: ${guard.reason}`, cfg.AI_MODEL]).catch(() => {});
    return { question, sql: parsed.sql, rows: [], rowCount: 0, ms: Date.now() - t0,
             answer: `The generated query was rejected: ${guard.reason}.`, error: guard.reason };
  }

  // --- 3. execute read-only --------------------------------------------
  let rows: any[] = [];
  try {
    rows = await readOnlyQuery(guard.sql!, 8000, { userId: opts.userId });
  } catch (e: any) {
    await q(`INSERT INTO ai_queries (question, generated_sql, error, model) VALUES ($1,$2,$3,$4)`,
      [question, guard.sql, e.message, cfg.AI_MODEL]).catch(() => {});
    return { question, sql: guard.sql!, rows: [], rowCount: 0, ms: Date.now() - t0,
             answer: `The query failed: ${e.message}`, error: e.message };
  }

  // --- 4. narrate -------------------------------------------------------
  const preview = JSON.stringify(rows.slice(0, 40), null, 0).slice(0, 12_000);
  const narr = await callAi({
    model: cfg.AI_MODEL,
    system: `You answer a collector's question from query results.
- Answer in 1-4 sentences of plain prose. No preamble, no restating the question.
- Quote the actual numbers. Prices are AUD.
- If a row's n_comps is 0 or low, or method is 'seed'/'tier_avg'/'parallel_mult', say the figure is an estimate rather than an observed price.
- If the result set is empty, say so and suggest what would populate it.
- No markdown tables (the UI renders the rows itself). No emoji.`,
    user: `QUESTION: ${question}\nROWS RETURNED: ${rows.length}\nDATA:\n${preview}`,
    maxTokens: 400,
    temperature: 0.1,
    purpose: 'nl2sql_answer',
  });

  const answer = narr?.text?.trim() ||
    (rows.length ? `${rows.length} row(s) returned — see the table.` : 'No matching rows.');

  await q(
    `INSERT INTO ai_queries (question, generated_sql, row_count, answer, model, ms) VALUES ($1,$2,$3,$4,$5,$6)`,
    [question, guard.sql, rows.length, answer.slice(0, 4000), cfg.AI_MODEL, Date.now() - t0],
  ).catch(() => {});

  return { question, sql: guard.sql!, rows, rowCount: rows.length, answer, note: parsed.note, ms: Date.now() - t0 };
}
