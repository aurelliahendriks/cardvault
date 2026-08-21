import { parse } from 'csv-parse/sync';
import { q, one } from '../db.js';
import { log } from '../logger.js';
import { baseSkuFor, resolveListing } from '../match/resolve.js';
import { toAud, round2 } from '../valuation/fx.js';

/**
 * Manual comp import. This is the tier that always works: no API keys, no
 * scraping, no rate limits. Paste rows off an eBay sold page or a Discord
 * screenshot and they become first-class comps with trust_weight 1.0.
 *
 * Accepted headers (case-insensitive, order-free):
 *   title, price, currency, shipping, sold_at, marketplace, url
 *   city, region, country          - optional, and the only way local sales get a location
 * Either `title` (which gets matched like any listing) or an explicit
 * `sku_id` / `legacy_id` column.
 *
 * The location columns matter more than they look. A card sold at a Melbourne meet or
 * through a Facebook group has no API and no sold-price history anywhere — if it is not
 * typed in here, that sale simply does not exist as far as the model is concerned, and the
 * local channel it came through can never be evaluated against eBay. `country` defaults
 * from the marketplace so a row with just `city: Melbourne` still lands correctly.
 */
export async function importCompsCsv(csv: string): Promise<{
  rows: number; matched: number; skipped: number; errors: string[];
}> {
  const records: any[] = parse(csv, { columns: (h) => h.map((c: string) => c.trim().toLowerCase()), skip_empty_lines: true, trim: true, relax_column_count: true });
  const errors: string[] = [];
  let matched = 0, skipped = 0;

  for (const [i, r] of records.entries()) {
    try {
      const price = Number(String(r.price ?? r.price_each ?? '').replace(/[^0-9.]/g, ''));
      if (!Number.isFinite(price) || price <= 0) { skipped++; continue; }

      const currency = String(r.currency ?? 'AUD').toUpperCase().slice(0, 3);
      const shipping = Number(String(r.shipping ?? '0').replace(/[^0-9.]/g, '')) || 0;
      const marketplace = String(r.marketplace ?? r.marketplace_code ?? 'EBAY_AU').toUpperCase();
      const soldAt = r.sold_at || r.date ? new Date(r.sold_at ?? r.date) : new Date();
      const title = String(r.title ?? r.name ?? '').trim();

      // Location, if the row carries one. Local sales are the whole reason this exists.
      const city = String(r.city ?? r.suburb ?? '').trim() || null;
      const region = String(r.region ?? r.state ?? '').trim().toUpperCase() || null;
      const country = (String(r.country ?? '').trim().toUpperCase()
        // A marketplace code implies its country; EBAY_AU without a country column is
        // still unambiguously Australia.
        || (/_AU$|^GUMTREE|^FACEBOOK_AU$|^LOCAL/.test(marketplace) ? 'AU'
          : /_US$/.test(marketplace) ? 'US'
          : /_UK$|_GB$/.test(marketplace) ? 'GB'
          : /_DE$/.test(marketplace) ? 'DE'
          : /_ES$/.test(marketplace) ? 'ES'
          : /_IT$/.test(marketplace) ? 'IT'
          : /_JP$|YAHOO/.test(marketplace) ? 'JP'
          : /_MX$|MERCADO/.test(marketplace) ? 'MX' : '')) || null;

      // resolve a SKU
      let skuId: number | null = null;
      if (r.sku_id) skuId = Number(r.sku_id);
      else if (r.legacy_id) {
        const c = await one<{ id: number }>(`SELECT id FROM cards WHERE legacy_id = $1`, [String(r.legacy_id)]);
        if (c) skuId = await baseSkuFor(c.id);
      } else if (title) {
        const m = await resolveListing(title, { allowLlm: true });
        skuId = m.skuId;
        if (!skuId) errors.push(`row ${i + 2}: could not match "${title.slice(0, 60)}" (${m.rejectReason ?? 'low confidence'})`);
      }
      if (!skuId) { skipped++; continue; }

      const externalId = `csv:${skuId}:${soldAt.toISOString().slice(0, 10)}:${price}:${i}`;
      const listing = await one<{ id: number }>(
        `INSERT INTO listings (source_code, marketplace_code, external_id, title, url, price,
                               currency, shipping, is_sold, sold_at,
                               seller_country, seller_region, seller_city, raw)
         VALUES ('csv_import',$1,$2,$3,$4,$5,$6,$7,TRUE,$8,$9,$10,$11,$12)
         ON CONFLICT (source_code, marketplace_code, external_id) DO UPDATE SET
           price = EXCLUDED.price,
           seller_country = COALESCE(EXCLUDED.seller_country, listings.seller_country),
           seller_region = COALESCE(EXCLUDED.seller_region, listings.seller_region),
           seller_city = COALESCE(EXCLUDED.seller_city, listings.seller_city)
         RETURNING id`,
        [marketplace, externalId, title || `manual comp`, r.url ?? null, price, currency, shipping,
         soldAt, country, region, city, JSON.stringify(r)],
      );

      const total = price + shipping;
      const rate = await toAud(currency);
      const priceAud = round2(total * rate);
      const usdRate = await toAud('USD');

      await q(
        `INSERT INTO comps (listing_id, sku_id, marketplace_code, sold_at, price_native, currency,
                            price_aud, price_usd, is_sold, match_method, match_confidence, excluded)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,TRUE,'manual',1.0,FALSE)
         ON CONFLICT (listing_id) DO NOTHING`,
        [listing!.id, skuId, marketplace, soldAt, total, currency, priceAud,
         usdRate > 0 ? round2(priceAud / usdRate) : 0],
      );
      matched++;
    } catch (e: any) {
      errors.push(`row ${i + 2}: ${e.message}`);
    }
  }

  log.info({ rows: records.length, matched, skipped }, 'comps CSV imported');
  return { rows: records.length, matched, skipped, errors: errors.slice(0, 50) };
}

/**
 * Holdings import, including the CSV the original HTML tracker exports.
 * Accepted headers: legacy_id|id, player, qty, price/est, parallel, grade, notes
 */
export async function importHoldingsCsv(csv: string): Promise<{
  rows: number; added: number; skipped: number; errors: string[];
}> {
  const records: any[] = parse(csv, { columns: (h) => h.map((c: string) => c.trim().toLowerCase()), skip_empty_lines: true, trim: true, relax_column_count: true });
  const errors: string[] = [];
  let added = 0, skipped = 0;

  for (const [i, r] of records.entries()) {
    try {
      const qty = Math.max(0, Number(r.qty ?? r.quantity ?? r.own ?? 1) || 0);
      if (qty <= 0) { skipped++; continue; }

      const legacy = String(r.legacy_id ?? r.id ?? '').trim();
      let cardId: number | null = null;
      if (legacy) {
        const c = await one<{ id: number }>(`SELECT id FROM cards WHERE legacy_id = $1`, [legacy]);
        cardId = c?.id ?? null;
      }
      if (!cardId && r.player) {
        const num = String(r.num ?? r.card_number ?? r.number ?? '').replace(/^#/, '');
        const c = await one<{ id: number }>(
          `SELECT id FROM cards
            WHERE unaccent(lower(player)) = unaccent(lower($1))
              AND ($2 = '' OR card_number = $2)
            ORDER BY (card_number = $2) DESC LIMIT 1`,
          [String(r.player), num],
        );
        cardId = c?.id ?? null;
      }
      if (!cardId) { errors.push(`row ${i + 2}: no card matched (${legacy || r.player})`); skipped++; continue; }

      const skuId = await baseSkuFor(cardId);
      const override = Number(String(r.price ?? r.est ?? r.value ?? '').replace(/[^0-9.]/g, ''));

      await q(
        `INSERT INTO holdings (sku_id, qty, price_override_aud, notes)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (sku_id) DO UPDATE SET qty = EXCLUDED.qty,
           price_override_aud = COALESCE(EXCLUDED.price_override_aud, holdings.price_override_aud),
           notes = COALESCE(EXCLUDED.notes, holdings.notes), updated_at = now()`,
        [skuId, qty, Number.isFinite(override) && override > 0 ? override : null, r.notes ?? r.note ?? null],
      );
      added++;
    } catch (e: any) {
      errors.push(`row ${i + 2}: ${e.message}`);
    }
  }

  log.info({ rows: records.length, added, skipped }, 'holdings CSV imported');
  return { rows: records.length, added, skipped, errors: errors.slice(0, 50) };
}

/**
 * Import a save file from the original single-file HTML tracker.
 * Shape is tolerant: it accepts { mine: {id: qty} }, { own: {...} },
 * { prices: {id: aud} }, { sold: [...] } and arrays of {id, qty, price}.
 */
export async function importLegacyJson(data: any): Promise<{
  holdings: number; overrides: number; sales: number; unmatched: string[];
}> {
  const unmatched: string[] = [];
  let holdings = 0, overrides = 0, sales = 0;

  const ownMap: Record<string, any> =
    data?.mine ?? data?.own ?? data?.owned ?? data?.holdings ?? {};
  const priceMap: Record<string, any> = data?.prices ?? data?.edited ?? data?.overrides ?? {};

  const cardIdFor = async (legacyId: string): Promise<number | null> => {
    const c = await one<{ id: number }>(`SELECT id FROM cards WHERE legacy_id = $1`, [legacyId]);
    if (!c) { unmatched.push(legacyId); return null; }
    return c.id;
  };

  // owned quantities
  const entries = Array.isArray(ownMap)
    ? ownMap.map((x: any) => [x.id, x.qty ?? x.q ?? 1] as const)
    : Object.entries(ownMap);

  for (const [legacyId, raw] of entries) {
    const qty = typeof raw === 'object' ? Number((raw as any).qty ?? (raw as any).q ?? 1) : Number(raw);
    if (!Number.isFinite(qty) || qty <= 0) continue;
    const cardId = await cardIdFor(String(legacyId));
    if (!cardId) continue;
    const skuId = await baseSkuFor(cardId);
    await q(
      `INSERT INTO holdings (sku_id, qty) VALUES ($1,$2)
         ON CONFLICT (sku_id) DO UPDATE SET qty = EXCLUDED.qty, updated_at = now()`,
      [skuId, qty],
    );
    holdings++;
  }

  // manual price overrides — these were real decisions, keep them
  for (const [legacyId, raw] of Object.entries(priceMap)) {
    const p = Number(raw);
    if (!Number.isFinite(p) || p <= 0) continue;
    const cardId = await cardIdFor(String(legacyId));
    if (!cardId) continue;
    const skuId = await baseSkuFor(cardId);
    await q(
      `INSERT INTO holdings (sku_id, qty, price_override_aud) VALUES ($1,0,$2)
         ON CONFLICT (sku_id) DO UPDATE SET price_override_aud = EXCLUDED.price_override_aud, updated_at = now()`,
      [skuId, p],
    );
    overrides++;
  }

  // sales log
  for (const s of (data?.sold ?? data?.sales ?? []) as any[]) {
    const legacyId = String(s.id ?? s.cardId ?? '');
    if (!legacyId) continue;
    const cardId = await cardIdFor(legacyId);
    if (!cardId) continue;
    const skuId = await baseSkuFor(cardId);
    const each = Number(s.price ?? s.p ?? s.each ?? 0);
    const qty = Number(s.qty ?? s.q ?? 1);
    if (!Number.isFinite(each) || each <= 0) continue;
    await q(
      `INSERT INTO sales (sku_id, qty, price_each, currency, price_each_aud, sold_at, notes, net_aud)
       VALUES ($1,$2,$3,'AUD',$3,COALESCE($4::timestamptz, now()),$5,$6)`,
      [skuId, qty, each, s.at ?? s.date ?? null, s.note ?? s.n ?? null, each * qty],
    );
    sales++;
  }

  // Clean up the zero-qty rows created purely to carry an override.
  await q(`DELETE FROM holdings WHERE qty = 0 AND price_override_aud IS NULL`);

  log.info({ holdings, overrides, sales, unmatched: unmatched.length }, 'legacy JSON imported');
  return { holdings, overrides, sales, unmatched: unmatched.slice(0, 50) };
}
