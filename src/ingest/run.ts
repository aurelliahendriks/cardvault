import { cfg, ingestMarketplaces } from '../config.js';
import { q, one } from '../db.js';
import { log } from '../logger.js';
import { resolveListing } from '../match/resolve.js';
import { askSources, soldChain } from '../sources/index.js';
import type { RawListing, SourceAdapter } from '../sources/types.js';
import { RateLimited } from '../sources/types.js';
import { toAud, round2 } from '../valuation/fx.js';
import { buildQueries, selectTargets, type CardRow } from './queryPlanner.js';

interface Marketplace {
  code: string; currency: string; ebay_marketplace_id: string | null;
}

async function marketplaces(): Promise<Marketplace[]> {
  return q<Marketplace>(
    `SELECT code, currency, ebay_marketplace_id FROM marketplaces
      WHERE active AND code = ANY($1::text[])`,
    [ingestMarketplaces],
  );
}

/** Persist a batch of raw listings, returning the ids that are new to us. */
async function persistListings(
  source: SourceAdapter,
  marketplaceCode: string,
  listings: RawListing[],
): Promise<number[]> {
  const newIds: number[] = [];
  for (const l of listings) {
    if (!l.title || !Number.isFinite(l.price) || l.price <= 0) continue;
    const row = await one<{ id: number; inserted: boolean }>(
      `INSERT INTO listings
         (source_code, marketplace_code, external_id, title, url, image_url, price, currency,
          shipping, is_sold, sold_at, seller, seller_country, seller_city, seller_region,
           condition_text, bids, format, quantity, raw)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
       ON CONFLICT (source_code, marketplace_code, external_id) DO UPDATE
         SET price = EXCLUDED.price,
             is_sold = listings.is_sold OR EXCLUDED.is_sold,
             sold_at = COALESCE(EXCLUDED.sold_at, listings.sold_at),
             observed_at = now()
       RETURNING id, (xmax = 0) AS inserted`,
      [source.code, marketplaceCode, l.externalId, l.title.slice(0, 500), l.url ?? null,
       l.imageUrl ?? null, l.price, (l.currency ?? 'AUD').toUpperCase(), l.shipping ?? 0,
       l.isSold, l.soldAt ?? null, l.seller ?? null, l.sellerCountry ?? null,
       // City and state were being thrown away; they are the only geographic detail any
       // source actually provides, and without them no map is possible at all.
       l.sellerCity ?? null, l.sellerRegion ?? null,
       l.conditionText ?? null, l.bids ?? null, l.format ?? null, l.quantity ?? 1,
       JSON.stringify(l.raw ?? {})],
    );
    if (row?.inserted) newIds.push(row.id);
  }
  return newIds;
}

/**
 * Match a set of listing ids to SKUs and write comps.
 * Only sold listings become comps; asks are kept as listings for the liquidity
 * calculation but never priced into fair value.
 */
export async function matchListings(listingIds: number[], opts: { allowLlm?: boolean } = {}) {
  let matched = 0, rejected = 0;

  for (const id of listingIds) {
    const l = await one<{
      id: number; title: string; price: number; currency: string; shipping: number;
      is_sold: boolean; sold_at: Date | null; marketplace_code: string; source_code: string;
      observed_at: Date; quantity: number;
    }>(`SELECT * FROM listings WHERE id = $1`, [id]);
    if (!l) continue;

    const already = await one(`SELECT 1 FROM comps WHERE listing_id = $1`, [id]);
    if (already) continue;

    const m = await resolveListing(l.title, opts);

    // Asks are useful for supply counts but must not enter the price series.
    const isSoldComp = l.is_sold;
    const soldAt = l.sold_at ?? l.observed_at;

    const total = Number(l.price) + Number(l.shipping ?? 0);
    const rate = await toAud(l.currency);
    const priceAud = round2(total * rate);
    const usdRate = await toAud('USD');
    const priceUsd = usdRate > 0 ? round2(priceAud / usdRate) : 0;

    const excluded = !m.skuId || !isSoldComp;
    const reason = !m.skuId ? (m.rejectReason ?? 'no_match') : !isSoldComp ? 'ask_not_sale' : null;

    await q(
      `INSERT INTO comps
         (listing_id, sku_id, marketplace_code, sold_at, price_native, currency,
          price_aud, price_usd, is_sold, match_method, match_confidence, parsed,
          excluded, exclude_reason)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       ON CONFLICT (listing_id) DO NOTHING`,
      [l.id, m.skuId, l.marketplace_code, soldAt, total, l.currency.toUpperCase(),
       priceAud, priceUsd, isSoldComp, m.method, m.confidence,
       JSON.stringify({ ...m.parsed, trail: m.trail }), excluded, reason],
    );

    if (m.skuId && isSoldComp) matched++; else rejected++;
  }

  return { matched, rejected };
}

/**
 * One ingest cycle.
 *
 * The query ladder matters: for each card we walk from tight to loose and stop
 * as soon as a rung produced enough matched sold comps. That keeps request
 * counts (and Bright Data spend) proportional to how hard a card is to find,
 * not to how many cards you own.
 */
export async function runIngest(opts: {
  mode: 'hot' | 'full' | 'held' | 'card';
  limit?: number;
  cardIds?: number[];
  minComps?: number;
  includeAsks?: boolean;
  allowLlm?: boolean;
}) {
  const targets = await selectTargets({
    mode: opts.mode,
    limit: opts.limit ?? (opts.mode === 'full' ? 400 : 120),
    minValueAud: cfg.INGEST_MIN_VALUE_AUD,
    cardIds: opts.cardIds,
  });
  const mkts = await marketplaces();
  const sold = soldChain();
  const asks = opts.includeAsks === false ? [] : askSources();
  const minComps = opts.minComps ?? 4;

  if (!sold.length && !asks.length) {
    log.warn('no ingest sources available — set EBAY_CLIENT_ID, BRIGHTDATA_API_KEY or SCRAPE_ENABLED');
    return { cards: 0, requests: 0, listings: 0, matched: 0 };
  }

  log.info(
    { cards: targets.length, marketplaces: mkts.map((m) => m.code), sold: sold.map((s) => s.code), asks: asks.map((s) => s.code) },
    'ingest cycle start',
  );

  let requests = 0, totalNew = 0, totalMatched = 0;

  for (const card of targets) {
    const queries = buildQueries(card as CardRow);

    for (const mkt of mkts) {
      let compsThisCard = 0;

      // --- sold comps: walk the query ladder -----------------------------
      outer: for (const query of queries) {
        for (const src of sold) {
          if (!src.available()) continue;
          const run = await startRun(src.code, mkt.code, query);
          try {
            const { listings, costUnits } = await src.fetch({
              query, marketplaceCode: mkt.code,
              ebayMarketplaceId: mkt.ebay_marketplace_id, limit: 120,
              since: new Date(Date.now() - 120 * 86400_000),
            });
            requests++;
            const ids = await persistListings(src, mkt.code, listings);
            const { matched } = await matchListings(ids, { allowLlm: opts.allowLlm });
            compsThisCard += matched;
            totalNew += ids.length;
            totalMatched += matched;
            await finishRun(run, 'ok', listings.length, ids.length, costUnits);
            if (compsThisCard >= minComps) break outer;
          } catch (e: any) {
            const rl = e instanceof RateLimited;
            await finishRun(run, rl ? 'partial' : 'error', 0, 0, 0, e.message);
            if (rl) {
              log.warn({ src: src.code, retryMs: e.retryAfterMs }, 'rate limited — skipping source this cycle');
              break;                 // try the next source, same query
            }
            log.error({ src: src.code, err: e.message }, 'source fetch failed');
          }
        }
      }

      // --- asks: one tight query per marketplace, for supply/sell-through --
      for (const src of asks) {
        if (!src.available()) continue;
        const query = queries[0]!;
        const run = await startRun(src.code, mkt.code, query);
        try {
          const { listings, costUnits } = await src.fetch({
            query, marketplaceCode: mkt.code,
            ebayMarketplaceId: mkt.ebay_marketplace_id, limit: 100,
          });
          requests++;
          const ids = await persistListings(src, mkt.code, listings);
          await matchListings(ids, { allowLlm: false });   // never spend tokens on asks
          totalNew += ids.length;
          await finishRun(run, 'ok', listings.length, ids.length, costUnits);
        } catch (e: any) {
          await finishRun(run, e instanceof RateLimited ? 'partial' : 'error', 0, 0, 0, e.message);
        }
      }
    }
  }

  log.info({ cards: targets.length, requests, listings: totalNew, matched: totalMatched }, 'ingest cycle done');
  return { cards: targets.length, requests, listings: totalNew, matched: totalMatched };
}

async function startRun(sourceCode: string, mkt: string, query: string): Promise<number> {
  const r = await one<{ id: number }>(
    `INSERT INTO source_runs (source_code, marketplace_code, query) VALUES ($1,$2,$3) RETURNING id`,
    [sourceCode, mkt, query.slice(0, 300)],
  );
  return r!.id;
}

async function finishRun(
  id: number, status: string, seen: number, added: number, cost: number, error?: string,
) {
  await q(
    `UPDATE source_runs SET finished_at = now(), status = $2, items_seen = $3,
            items_new = $4, cost_units = $5, error = $6 WHERE id = $1`,
    [id, status, seen, added, cost, error?.slice(0, 800) ?? null],
  );
}
