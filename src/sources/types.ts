/** A listing as returned by any source, before matching. */
export interface RawListing {
  externalId: string;
  title: string;
  url?: string;
  imageUrl?: string;
  price: number;
  currency: string;
  shipping?: number;
  isSold: boolean;
  soldAt?: Date;
  seller?: string;
  sellerCountry?: string;
  /** eBay's itemLocation.city — the finest geographic grain any source gives us. */
  sellerCity?: string;
  /** itemLocation.stateOrProvince. "VIC", "NSW", "CA", and so on. */
  sellerRegion?: string;
  conditionText?: string;
  bids?: number;
  format?: 'auction' | 'fixed' | 'best_offer';
  quantity?: number;
  raw?: unknown;
}

export interface FetchContext {
  /** free-text search, already built by the query planner */
  query: string;
  marketplaceCode: string;
  /** eBay marketplace id if applicable */
  ebayMarketplaceId?: string | null;
  limit?: number;
  /** only return sales at or after this instant */
  since?: Date;
}

export interface SourceAdapter {
  code: string;
  kind: 'api' | 'scrape' | 'manual';
  givesSold: boolean;
  /** false when credentials/flags are missing — the runner skips it cleanly */
  available(): boolean;
  fetch(ctx: FetchContext): Promise<{ listings: RawListing[]; costUnits: number }>;
}

export class SourceUnavailable extends Error {}
export class RateLimited extends Error {
  constructor(msg: string, public retryAfterMs = 60_000) { super(msg); }
}
