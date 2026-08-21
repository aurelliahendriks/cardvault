import { cfg } from '../config.js';
import { log } from '../logger.js';
import { parseEbaySoldHtml } from './brightdata.js';
import { RateLimited, type FetchContext, type RawListing, type SourceAdapter } from './types.js';

/**
 * Free, self-hosted scraping. This WILL get blocked — that is not a bug in the
 * code, it is what happens when you request a bot-protected page from a single
 * datacentre IP. It exists as the zero-cost tier: fine for a few hundred
 * requests a day from a residential-ish server, useless at scale.
 *
 * Guardrails: single-flight global mutex, enforced minimum delay between
 * requests, and a circuit breaker that disables the adapter for an hour after
 * repeated blocks so you don't hammer a wall.
 */

let lastRequestAt = 0;
let inFlight: Promise<unknown> = Promise.resolve();
let consecutiveBlocks = 0;
let disabledUntil = 0;

async function throttledFetch(url: string, headers: Record<string, string> = {}): Promise<string> {
  if (Date.now() < disabledUntil) {
    throw new RateLimited(
      `self-scrape circuit breaker open until ${new Date(disabledUntil).toISOString()}`,
      disabledUntil - Date.now(),
    );
  }

  // Serialize every request through one chain so SCRAPE_MIN_DELAY_MS is real
  // even when several jobs run concurrently.
  const run = inFlight.then(async () => {
    const wait = Math.max(0, cfg.SCRAPE_MIN_DELAY_MS - (Date.now() - lastRequestAt));
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastRequestAt = Date.now();

    const res = await fetch(url, {
      headers: {
        'User-Agent': cfg.SCRAPE_USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-AU,en;q=0.9',
        ...headers,
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(30_000),
    });

    if (res.status === 429 || res.status === 403 || res.status === 503) {
      consecutiveBlocks++;
      if (consecutiveBlocks >= 3) {
        disabledUntil = Date.now() + 60 * 60_000;
        log.warn({ status: res.status }, 'self-scrape blocked 3x — opening circuit breaker for 1h');
      }
      throw new RateLimited(`blocked with HTTP ${res.status}`, 10 * 60_000);
    }
    if (!res.ok) throw new Error(`scrape ${res.status} on ${url.slice(0, 120)}`);

    const html = await res.text();
    if (/captcha|are you a human|pardon our interruption/i.test(html.slice(0, 4000))) {
      consecutiveBlocks++;
      throw new RateLimited('captcha interstitial returned', 15 * 60_000);
    }
    consecutiveBlocks = 0;
    return html;
  });

  inFlight = run.catch(() => {});
  return run as Promise<string>;
}

const EBAY_DOMAIN: Record<string, string> = {
  EBAY_AU: 'ebay.com.au', EBAY_US: 'ebay.com', EBAY_UK: 'ebay.co.uk',
  EBAY_DE: 'ebay.de', EBAY_ES: 'ebay.es',
};
const CCY: Record<string, string> = {
  EBAY_AU: 'AUD', EBAY_US: 'USD', EBAY_UK: 'GBP', EBAY_DE: 'EUR', EBAY_ES: 'EUR',
};

export const selfScrapeEbaySold: SourceAdapter = {
  code: 'scrape_ebay_sold',
  kind: 'scrape',
  givesSold: true,
  available: () => cfg.SCRAPE_ENABLED && Date.now() >= disabledUntil,

  async fetch(ctx: FetchContext) {
    const domain = EBAY_DOMAIN[ctx.marketplaceCode];
    if (!domain) return { listings: [], costUnits: 0 };
    const url =
      `https://www.${domain}/sch/i.html?` +
      new URLSearchParams({
        _nkw: ctx.query, LH_Sold: '1', LH_Complete: '1',
        _sacat: '212', _ipg: '120', _sop: '13',
      });
    const html = await throttledFetch(url);
    const listings = parseEbaySoldHtml(html, CCY[ctx.marketplaceCode] ?? 'AUD');
    return { listings, costUnits: 1 };
  },
};

/**
 * SportsCardsPro sold history. Their pages are much lighter than eBay's and
 * they aggregate across sources, which makes them a good sanity check on a
 * thin eBay comp set. Keep the request rate low and honour their terms.
 */
export const scrapeSportsCardsPro: SourceAdapter = {
  code: 'scrape_sportscardspro',
  kind: 'scrape',
  givesSold: true,
  available: () => cfg.SCRAPE_ENABLED,

  async fetch(ctx: FetchContext) {
    const url = `https://www.sportscardspro.com/search-products?q=${encodeURIComponent(ctx.query)}&type=prices`;
    const html = await throttledFetch(url);

    // Rows look like: <tr><td class="title"><a href="/game/...">NAME</a></td>
    //                 <td class="price">$12.34</td>...
    const listings: RawListing[] = [];
    const rows = html.split(/<tr[^>]*>/i).slice(1);
    for (const row of rows) {
      const linkm = /<a[^>]+href="(\/game\/[^"]+)"[^>]*>([^<]{6,200})<\/a>/i.exec(row);
      if (!linkm) continue;
      const prices = [...row.matchAll(/\$\s?([\d,]+(?:\.\d{2})?)/g)].map((m) => Number(m[1]!.replace(/,/g, '')));
      const price = prices[0];
      if (!price || !Number.isFinite(price)) continue;
      listings.push({
        externalId: `scp:${linkm[1]}`,
        title: linkm[2]!.replace(/\s+/g, ' ').trim(),
        url: `https://www.sportscardspro.com${linkm[1]}`,
        price,
        currency: 'USD',
        shipping: 0,
        isSold: true,
        soldAt: new Date(),           // SCP reports a rolling average, not a dated sale
        format: 'fixed',
        raw: { source: 'sportscardspro', allPrices: prices },
      });
    }
    log.debug({ q: ctx.query, n: listings.length }, 'sportscardspro fetch');
    return { listings, costUnits: 1 };
  },
};
