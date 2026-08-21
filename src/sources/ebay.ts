import { cfg, hasEbay } from '../config.js';
import { log } from '../logger.js';
import { RateLimited, type FetchContext, type RawListing, type SourceAdapter } from './types.js';

const HOST = () => (cfg.EBAY_ENV === 'sandbox' ? 'api.sandbox.ebay.com' : 'api.ebay.com');

// --- OAuth (client credentials — public data only, no user consent) --------

let token: { value: string; expiresAt: number } | null = null;

async function appToken(): Promise<string> {
  if (token && token.expiresAt > Date.now() + 60_000) return token.value;
  if (!hasEbay()) throw new Error('EBAY_CLIENT_ID / EBAY_CLIENT_SECRET not set');

  const basic = Buffer.from(`${cfg.EBAY_CLIENT_ID}:${cfg.EBAY_CLIENT_SECRET}`).toString('base64');
  const res = await fetch(`https://${HOST()}/identity/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      scope: 'https://api.ebay.com/oauth/api_scope',
    }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`eBay token failed: ${res.status} ${await res.text()}`);
  const j: any = await res.json();
  token = { value: j.access_token, expiresAt: Date.now() + (j.expires_in ?? 7200) * 1000 };
  return token.value;
}

async function ebayGet(path: string, marketplaceId: string): Promise<any> {
  const res = await fetch(`https://${HOST()}${path}`, {
    headers: {
      Authorization: `Bearer ${await appToken()}`,
      'X-EBAY-C-MARKETPLACE-ID': marketplaceId,
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (res.status === 429) {
    throw new RateLimited('eBay rate limit hit', 15 * 60_000);
  }
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`eBay ${res.status} on ${path.slice(0, 120)}: ${body.slice(0, 300)}`);
  }
  return res.json();
}

const money = (m: any): number => (m?.value != null ? Number(m.value) : 0);

/** Trading-card leaf categories differ per site; 261328 (Sports Trading Cards) is safe on most. */
const CARD_CATEGORY = '261328';

// ---------------------------------------------------------------------------
// Browse API — ACTIVE listings. These are asking prices, not sales.
// We ingest them anyway: supply count and sell-through are half the liquidity
// signal, and an ask distribution bounds a thin-comp valuation.
// ---------------------------------------------------------------------------

export const ebayBrowse: SourceAdapter = {
  code: 'ebay_browse',
  kind: 'api',
  givesSold: false,
  available: () => hasEbay(),

  async fetch(ctx: FetchContext) {
    const mkt = ctx.ebayMarketplaceId ?? 'EBAY_AU';
    const limit = Math.min(ctx.limit ?? 100, 200);
    const params = new URLSearchParams({
      q: ctx.query,
      limit: String(Math.min(limit, 200)),
      category_ids: CARD_CATEGORY,
      fieldgroups: 'EXTENDED',
      filter: 'buyingOptions:{FIXED_PRICE|AUCTION},conditionIds:{2750|4000|5000|1000|3000}',
      sort: 'price',
    });

    const j = await ebayGet(`/buy/browse/v1/item_summary/search?${params}`, mkt);
    const items: any[] = j.itemSummaries ?? [];

    const listings: RawListing[] = items.map((it) => ({
      externalId: String(it.itemId),
      title: String(it.title ?? ''),
      url: it.itemWebUrl,
      imageUrl: it.image?.imageUrl ?? it.thumbnailImages?.[0]?.imageUrl,
      price: money(it.price),
      currency: it.price?.currency ?? 'AUD',
      shipping: money(it.shippingOptions?.[0]?.shippingCost),
      isSold: false,
      seller: it.seller?.username,
      sellerCountry: it.itemLocation?.country,
      sellerCity: it.itemLocation?.city,
      sellerRegion: it.itemLocation?.stateOrProvince,
      conditionText: it.condition,
      bids: it.bidCount ?? undefined,
      format: (it.buyingOptions ?? []).includes('AUCTION') ? 'auction' : 'fixed',
      quantity: 1,
      raw: it,
    }));

    return { listings, costUnits: 1 };
  },
};

// ---------------------------------------------------------------------------
// Marketplace Insights API — 90 days of SOLD items.
// This is the good stuff, and it is a LIMITED RELEASE: you must apply through
// developer.ebay.com and be approved. Until then EBAY_INSIGHTS_ENABLED stays
// false and the runner falls back to Bright Data / self-scrape for sold comps.
// ---------------------------------------------------------------------------

export const ebayInsights: SourceAdapter = {
  code: 'ebay_insights',
  kind: 'api',
  givesSold: true,
  available: () => hasEbay() && cfg.EBAY_INSIGHTS_ENABLED,

  async fetch(ctx: FetchContext) {
    const mkt = ctx.ebayMarketplaceId ?? 'EBAY_AU';
    const filters = [`categoryIds:{${CARD_CATEGORY}}`];
    if (ctx.since) {
      filters.push(`lastSoldDate:[${ctx.since.toISOString().replace(/\.\d{3}Z$/, 'Z')}]`);
    }
    const params = new URLSearchParams({
      q: ctx.query,
      limit: String(Math.min(ctx.limit ?? 100, 200)),
      filter: filters.join(','),
    });

    const j = await ebayGet(`/buy/marketplace_insights/v1_beta/item_sales/search?${params}`, mkt);
    const items: any[] = j.itemSales ?? [];

    const listings: RawListing[] = items.map((it) => ({
      externalId: String(it.itemId ?? `${it.legacyItemId}-${it.lastSoldDate}`),
      title: String(it.title ?? ''),
      url: it.itemWebUrl,
      imageUrl: it.image?.imageUrl,
      price: money(it.lastSoldPrice ?? it.price),
      currency: (it.lastSoldPrice ?? it.price)?.currency ?? 'AUD',
      shipping: money(it.shippingOptions?.[0]?.shippingCost),
      isSold: true,
      soldAt: it.lastSoldDate ? new Date(it.lastSoldDate) : undefined,
      seller: it.seller?.username,
      sellerCountry: it.itemLocation?.country,
      sellerCity: it.itemLocation?.city,
      sellerRegion: it.itemLocation?.stateOrProvince,
      conditionText: it.condition,
      bids: it.bidCount ?? undefined,
      format: (it.buyingOptions ?? []).includes('AUCTION') ? 'auction' : 'fixed',
      quantity: it.totalSoldQuantity ?? 1,
      raw: it,
    }));

    log.debug({ q: ctx.query, mkt, n: listings.length }, 'insights fetch');
    return { listings, costUnits: 1 };
  },
};
