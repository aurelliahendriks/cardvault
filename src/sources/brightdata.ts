import { cfg, hasBrightData } from '../config.js';
import { q } from '../db.js';
import { log } from '../logger.js';
import type { FetchContext, RawListing, SourceAdapter } from './types.js';

/**
 * Bright Data Web Unlocker against eBay's *sold* search results.
 *
 * Why this exists: eBay's sold-comp API (Marketplace Insights) is a limited
 * release you have to be approved for. Until then, the sold-listings page is
 * the only reliable source of realized prices, and it is aggressively
 * bot-protected. Web Unlocker handles that.
 *
 * This costs money per request, so it is gated behind a monthly cap that is
 * enforced against the source_runs ledger before every call.
 */

const EBAY_DOMAIN: Record<string, string> = {
  EBAY_AU: 'ebay.com.au',
  EBAY_US: 'ebay.com',
  EBAY_UK: 'ebay.co.uk',
  EBAY_DE: 'ebay.de',
  EBAY_ES: 'ebay.es',
  EBAY_JP: 'ebay.com',
};

const CCY: Record<string, string> = {
  EBAY_AU: 'AUD', EBAY_US: 'USD', EBAY_UK: 'GBP',
  EBAY_DE: 'EUR', EBAY_ES: 'EUR', EBAY_JP: 'USD',
};

async function monthlySpend(): Promise<number> {
  const rows = await q<{ n: number }>(
    `SELECT COALESCE(SUM(cost_units),0)::float AS n FROM source_runs
      WHERE source_code LIKE 'brightdata%' AND started_at >= date_trunc('month', now())`,
  );
  return rows[0]?.n ?? 0;
}

async function unlock(url: string): Promise<string> {
  const cap = cfg.BRIGHTDATA_MONTHLY_REQUEST_CAP;
  if (cap > 0 && (await monthlySpend()) >= cap) {
    throw new Error(`Bright Data monthly cap of ${cap} requests reached — raise BRIGHTDATA_MONTHLY_REQUEST_CAP or wait for the reset`);
  }

  const res = await fetch('https://api.brightdata.com/request', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${cfg.BRIGHTDATA_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ zone: cfg.BRIGHTDATA_ZONE, url, format: 'raw' }),
    signal: AbortSignal.timeout(90_000),
  });
  if (!res.ok) throw new Error(`Bright Data ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.text();
}

// --- HTML extraction ------------------------------------------------------
// eBay's markup shifts every few months. Rather than one brittle selector
// chain, pull each field with several independent patterns and take the first
// that yields something plausible. When a field goes fully missing the parser
// returns fewer listings instead of wrong ones — check /api/health/sources.

function textBetween(s: string, startRe: RegExp, endRe: RegExp): string | null {
  const m = startRe.exec(s);
  if (!m) return null;
  const rest = s.slice(m.index + m[0].length);
  const e = endRe.exec(rest);
  return (e ? rest.slice(0, e.index) : rest).trim() || null;
}

const stripTags = (s: string) =>
  s.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&#0?39;|&apos;/g, "'")
   .replace(/&quot;/g, '"').replace(/&nbsp;/g, ' ').replace(/&[a-z]+;/gi, ' ')
   .replace(/\s+/g, ' ').trim();

function parseMoney(s: string): number | null {
  const m = s.replace(/,/g, '').match(/([\d]+(?:\.\d{1,2})?)/);
  return m ? Number(m[1]) : null;
}

export function parseEbaySoldHtml(html: string, currency: string): RawListing[] {
  const out: RawListing[] = [];
  // Each result is an <li class="s-item ..."> ... </li> (or s-card in newer markup)
  const blocks = html.split(/<li[^>]+class="[^"]*s-(?:item|card)[^"]*"/i).slice(1);

  for (const blk of blocks) {
    const chunk = blk.slice(0, 6000);

    const idm = /\/itm\/(\d{9,15})/.exec(chunk);
    if (!idm) continue;
    const externalId = idm[1]!;

    const titleRaw =
      textBetween(chunk, /class="[^"]*s-item__title[^"]*"[^>]*>/i, /<\/(?:span|div|h3)>/i) ??
      textBetween(chunk, /role="heading"[^>]*>/i, /<\/(?:span|div|h3)>/i) ??
      '';
    const title = stripTags(titleRaw).replace(/^New Listing/i, '').trim();
    if (title.length < 8) continue;

    const priceRaw =
      textBetween(chunk, /class="[^"]*s-item__price[^"]*"[^>]*>/i, /<\/(?:span|div)>/i) ?? '';
    const price = parseMoney(stripTags(priceRaw));
    if (price == null || price <= 0) continue;
    // Price ranges ("$5.00 to $20.00") are multi-variant listings — useless as comps.
    if (/\bto\b/i.test(stripTags(priceRaw))) continue;

    const shipRaw =
      textBetween(chunk, /class="[^"]*s-item__shipping[^"]*"[^>]*>/i, /<\/(?:span|div)>/i) ?? '';
    const shipTxt = stripTags(shipRaw);
    const shipping = /free/i.test(shipTxt) ? 0 : parseMoney(shipTxt) ?? 0;

    // "Sold  12 Jul 2026" / "Sold Jul 12, 2026"
    const soldRaw =
      textBetween(chunk, /class="[^"]*s-item__caption--signal[^"]*"[^>]*>/i, /<\/(?:span|div)>/i) ??
      textBetween(chunk, /class="[^"]*POSITIVE[^"]*"[^>]*>/i, /<\/span>/i) ??
      '';
    const soldTxt = stripTags(soldRaw).replace(/^sold\s*/i, '');
    const soldAt = soldTxt ? new Date(soldTxt) : undefined;

    const bidsRaw = /(\d+)\s*bids?/i.exec(stripTags(chunk.slice(0, 4000)));
    const imgm = /<img[^>]+src="(https:\/\/i\.ebayimg\.com\/[^"]+)"/i.exec(chunk);

    out.push({
      externalId,
      title,
      url: `https://www.ebay.com/itm/${externalId}`,
      imageUrl: imgm?.[1],
      price,
      currency,
      shipping,
      isSold: true,
      soldAt: soldAt && !Number.isNaN(soldAt.getTime()) ? soldAt : undefined,
      bids: bidsRaw ? Number(bidsRaw[1]) : undefined,
      format: bidsRaw ? 'auction' : 'fixed',
      quantity: 1,
      raw: { source: 'brightdata_ebay_sold', soldTxt, priceTxt: stripTags(priceRaw) },
    });
  }
  return out;
}

export const brightdataEbaySold: SourceAdapter = {
  code: 'brightdata_ebay_sold',
  kind: 'scrape',
  givesSold: true,
  available: () => hasBrightData(),

  async fetch(ctx: FetchContext) {
    const domain = EBAY_DOMAIN[ctx.marketplaceCode];
    if (!domain) return { listings: [], costUnits: 0 };

    // LH_Sold=1 & LH_Complete=1 = sold listings only. _ipg=120 = 120 per page.
    const url =
      `https://www.${domain}/sch/i.html?` +
      new URLSearchParams({
        _nkw: ctx.query,
        LH_Sold: '1',
        LH_Complete: '1',
        _sacat: '212',        // Sports Mem, Cards & Fan Shop
        _ipg: '120',
        _sop: '13',           // newest first
      });

    const html = await unlock(url);
    const listings = parseEbaySoldHtml(html, CCY[ctx.marketplaceCode] ?? 'AUD');
    log.debug({ q: ctx.query, mkt: ctx.marketplaceCode, n: listings.length }, 'brightdata sold fetch');

    if (listings.length === 0 && html.length > 20_000) {
      log.warn({ mkt: ctx.marketplaceCode, bytes: html.length },
        'Bright Data returned a full page but the parser found 0 listings — eBay markup likely changed');
    }
    return { listings, costUnits: 1 };
  },
};
