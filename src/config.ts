import { z } from 'zod';

const bool = (d: boolean) =>
  z.string().optional().transform((v) => (v == null || v === '' ? d : /^(1|true|yes|on)$/i.test(v)));
const num = (d: number) =>
  z.string().optional().transform((v) => (v == null || v === '' ? d : Number(v)));
const str = (d = '') => z.string().optional().transform((v) => (v == null ? d : v));

const Schema = z.object({
  DATABASE_URL: str('postgres://cardvault:cardvault@localhost:5432/cardvault'),
  REDIS_URL: str('redis://localhost:6379'),
  PORT: num(8080),
  LOG_LEVEL: str('info'),
  ADMIN_API_KEY: str(''),
  /**
   * Trust `X-Forwarded-For` / `X-Forwarded-Proto`. Off by default, and that default is the
   * security decision.
   *
   * Behind a tunnel or a reverse proxy, every request arrives from the proxy's address, so
   * without this the login throttle keys every attempt in the world to one bucket — five wrong
   * guesses and nobody can sign in — and the "is this https" test used to mark the session
   * cookie `secure` reads the hop to the proxy rather than the browser's connection.
   *
   * Turned on when NOT behind a proxy, it is worse than useless: `X-Forwarded-For` becomes a
   * header anybody can set, so an attacker rotates it and the login throttle stops existing.
   * Hence a switch you set deliberately when you put a proxy in front, rather than a default
   * that is wrong in one direction or the other.
   */
  TRUST_PROXY: bool(false),
  BASE_CURRENCY: str('AUD'),

  ANTHROPIC_API_KEY: str(''),
  AI_MODEL: str('claude-sonnet-4-5'),
  AI_MATCH_MODEL: str('claude-haiku-4-5'),
  AI_MONTHLY_BUDGET_USD: num(20),
  EMBEDDING_PROVIDER: str('none'),
  VOYAGE_API_KEY: str(''),
  OPENAI_API_KEY: str(''),

  EBAY_CLIENT_ID: str(''),
  EBAY_CLIENT_SECRET: str(''),
  EBAY_ENV: str('production'),
  EBAY_INSIGHTS_ENABLED: bool(false),

  BRIGHTDATA_API_KEY: str(''),
  BRIGHTDATA_ZONE: str('web_unlocker1'),
  BRIGHTDATA_ENABLED: bool(false),
  BRIGHTDATA_MONTHLY_REQUEST_CAP: num(5000),

  SCRAPE_ENABLED: bool(false),
  SCRAPE_CONCURRENCY: num(1),
  SCRAPE_MIN_DELAY_MS: num(8000),
  SCRAPE_USER_AGENT: str('CardVault/1.0 (personal collection tracker)'),

  FX_PROVIDER: str('frankfurter'),

  CRON_FX: str('15 6 * * *'),
  CRON_INGEST_HOT: str('0 */4 * * *'),
  CRON_INGEST_FULL: str('0 3 * * *'),
  CRON_REVALUE: str('30 4 * * *'),
  CRON_RECOMMEND: str('0 5 * * *'),
  CRON_IMAGES: str('45 4 * * *'),
  // Every 20 minutes rather than daily. A backlog of 600 players at 60 a day would take
  // ten days, and the run kept dying with the terminal that launched it — a cron that
  // resumes itself is the difference between "finishes overnight" and "never finishes".
  // Once nothing is pending this costs one SQL query and makes no requests at all.
  CRON_PORTRAITS: str('*/20 * * * *'),
  PORTRAITS_BATCH: num(40),
  // Hourly, because an alert's value is being timely and the rules are pure SQL over
  // data already collected. This keeps the schedule the worker was already running before
  // it became configurable — the previous hardcoded registration used the same pattern.
  CRON_ALERTS: str('20 * * * *'),
  IMAGE_CACHE_DIR: str('/tmp/cardvault-images'),
  /**
   * Where photographs of your own cards are written.
   *
   * Deliberately NOT under IMAGE_CACHE_DIR. That directory is a cache — it holds images
   * fetched from listings and can be deleted at any time with no loss, and it defaults to
   * /tmp for exactly that reason. These are photographs of physical objects and cannot be
   * re-fetched from anywhere. Putting irreplaceable files inside a folder whose name invites
   * you to clear it is how they get cleared.
   *
   * Bind-mounted to a folder on the host in docker-compose, so it survives the container and
   * can be opened in Explorer.
   */
  PHOTO_DIR: str('/data/photos'),

  INGEST_MARKETPLACES: str('EBAY_AU,EBAY_US,EBAY_UK,EBAY_DE'),
  INGEST_MIN_VALUE_AUD: num(8),
});

export const cfg = Schema.parse(process.env);

export const ingestMarketplaces = cfg.INGEST_MARKETPLACES.split(',')
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean);

export const hasAI = () => cfg.ANTHROPIC_API_KEY.length > 0;
export const hasEbay = () => cfg.EBAY_CLIENT_ID.length > 0 && cfg.EBAY_CLIENT_SECRET.length > 0;
export const hasBrightData = () => cfg.BRIGHTDATA_ENABLED && cfg.BRIGHTDATA_API_KEY.length > 0;

/** Which capabilities are live — surfaced on /api/health so the UI can grey things out. */
export function capabilities() {
  return {
    ai: hasAI(),
    embeddings: cfg.EMBEDDING_PROVIDER !== 'none',
    ebay_browse: hasEbay(),
    ebay_insights: hasEbay() && cfg.EBAY_INSIGHTS_ENABLED,
    brightdata: hasBrightData(),
    self_scrape: cfg.SCRAPE_ENABLED,
  };
}
