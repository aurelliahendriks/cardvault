import { cfg } from '../config.js';
import { q, one } from '../db.js';
import { log } from '../logger.js';

const CURRENCIES = ['USD', 'GBP', 'EUR', 'JPY', 'MXN', 'ARS', 'SGD', 'CAD', 'AUD'] as const;

let cache: { at: number; rates: Map<string, number> } = { at: 0, rates: new Map() };
const CACHE_MS = 10 * 60 * 1000;

/** Rate to convert 1 unit of `ccy` into AUD, as of the most recent stored date. */
export async function toAud(ccy: string): Promise<number> {
  const c = ccy.toUpperCase();
  if (c === 'AUD') return 1;
  if (Date.now() - cache.at < CACHE_MS && cache.rates.has(c)) return cache.rates.get(c)!;

  const rows = await q<{ quote: string; rate: number }>(
    `SELECT DISTINCT ON (base) base AS quote, rate
       FROM fx_rates WHERE quote = 'AUD'
      ORDER BY base, as_of DESC`,
  );
  cache = { at: Date.now(), rates: new Map(rows.map((r) => [r.quote, r.rate])) };
  cache.rates.set('AUD', 1);

  const rate = cache.rates.get(c);
  if (rate == null) {
    log.warn({ ccy: c }, 'no FX rate stored; treating 1:1 — fix with `npm run ingest -- fx`');
    return 1;
  }
  return rate;
}

export async function convert(amount: number, from: string, to = 'AUD'): Promise<number> {
  if (!Number.isFinite(amount)) return 0;
  const audAmount = amount * (await toAud(from));
  if (to.toUpperCase() === 'AUD') return round2(audAmount);
  const target = await toAud(to);
  return round2(target === 0 ? 0 : audAmount / target);
}

export const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Refresh FX from a free, key-less provider. Stores both directions so either
 * lookup works, and stores the same date idempotently.
 */
export async function refreshFx(): Promise<number> {
  const url =
    cfg.FX_PROVIDER === 'exchangerate'
      ? `https://api.exchangerate.host/latest?base=AUD&symbols=${CURRENCIES.join(',')}`
      : `https://api.frankfurter.app/latest?from=AUD&to=${CURRENCIES.filter((c) => c !== 'AUD').join(',')}`;

  let data: any;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    data = await res.json();
  } catch (e: any) {
    log.error({ err: e.message, url }, 'FX refresh failed; keeping previous rates');
    return 0;
  }

  const rates: Record<string, number> = data?.rates ?? {};
  const asOf: string = data?.date ?? new Date().toISOString().slice(0, 10);
  let n = 0;

  for (const [ccy, audToCcy] of Object.entries(rates)) {
    if (!Number.isFinite(audToCcy) || audToCcy <= 0) continue;
    // provider gives AUD -> ccy; we want both directions
    await q(
      `INSERT INTO fx_rates (as_of, base, quote, rate, source) VALUES ($1,'AUD',$2,$3,$4)
         ON CONFLICT (as_of, base, quote) DO UPDATE SET rate = EXCLUDED.rate, source = EXCLUDED.source`,
      [asOf, ccy, audToCcy, cfg.FX_PROVIDER],
    );
    await q(
      `INSERT INTO fx_rates (as_of, base, quote, rate, source) VALUES ($1,$2,'AUD',$3,$4)
         ON CONFLICT (as_of, base, quote) DO UPDATE SET rate = EXCLUDED.rate, source = EXCLUDED.source`,
      [asOf, ccy, 1 / audToCcy, cfg.FX_PROVIDER],
    );
    n++;
  }
  await q(
    `INSERT INTO fx_rates (as_of, base, quote, rate, source) VALUES ($1,'AUD','AUD',1,'identity')
       ON CONFLICT (as_of, base, quote) DO NOTHING`,
    [asOf],
  );

  cache = { at: 0, rates: new Map() };
  log.info({ asOf, pairs: n }, 'FX refreshed');
  return n;
}

/** 30-day % change in a currency vs AUD — feeds the "sell offshore now?" signal. */
export async function fxTrend30d(ccy: string): Promise<number | null> {
  if (ccy.toUpperCase() === 'AUD') return 0;
  const row = await one<{ now: number; then: number }>(
    `SELECT
       (SELECT rate FROM fx_rates WHERE base=$1 AND quote='AUD' ORDER BY as_of DESC LIMIT 1) AS now,
       (SELECT rate FROM fx_rates WHERE base=$1 AND quote='AUD' AND as_of <= CURRENT_DATE - 30
         ORDER BY as_of DESC LIMIT 1) AS then`,
    [ccy.toUpperCase()],
  );
  if (!row?.now || !row?.then) return null;
  return round2(((row.now - row.then) / row.then) * 100);
}
