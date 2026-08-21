import { brightdataEbaySold } from './brightdata.js';
import { ebayBrowse, ebayInsights } from './ebay.js';
import { scrapeSportsCardsPro, selfScrapeEbaySold } from './selfScrape.js';
import type { SourceAdapter } from './types.js';

export const adapters: SourceAdapter[] = [
  ebayInsights,          // best: real sold data via official API
  brightdataEbaySold,    // next: paid scrape of sold pages
  selfScrapeEbaySold,    // free fallback, gets blocked
  scrapeSportsCardsPro,  // cross-check
  ebayBrowse,            // asks only — liquidity signal
];

export function byCode(code: string): SourceAdapter | undefined {
  return adapters.find((a) => a.code === code);
}

/**
 * Sold-comp sources in preference order, filtered to what's actually
 * configured. The runner walks this list and stops at the first that returns
 * usable data, so you never pay Bright Data for something Insights covers.
 */
export function soldChain(): SourceAdapter[] {
  return adapters.filter((a) => a.givesSold && a.available());
}

export function askSources(): SourceAdapter[] {
  return adapters.filter((a) => !a.givesSold && a.available());
}

export { ebayBrowse, ebayInsights, brightdataEbaySold, selfScrapeEbaySold, scrapeSportsCardsPro };
export type { SourceAdapter } from './types.js';
