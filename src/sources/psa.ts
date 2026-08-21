/**
 * PSA population: grade scarcity, kept deliberately separate from condition.
 *
 * A PSA 10 is *condition*. A PSA 10 out of 40 graded is a different card from a PSA 10
 * out of 4,000 — and that is *population context*, a second axis. Folding it into the
 * condition score would make two different claims indistinguishable, so this never
 * touches `conditionScore()`.
 *
 * Two more things this module refuses to do, both of them tempting:
 *
 * 1. **No value bonus from a low population.** A population of 3 can mean rare, or
 *    unpopular, or too new, or not worth grading, or that owners prefer BGS. Only market
 *    evidence distinguishes those, and market evidence already has its own axis.
 * 2. **No scraping.** PSA publishes a real API with a population endpoint; if you don't
 *    have a token, the honest state is "unknown", not a scraper that breaks silently and
 *    fills the database with plausible nonsense. Set PSA_API_TOKEN and it works; leave it
 *    unset and every card reads "population not checked".
 *
 * Coverage is meant to be partial on purpose — the valuable cards and the grading
 * candidates. Fetching population for all 1,771 cards would spend a lot of requests to
 * learn that ungraded commons have no population.
 */

import { q, one } from '../db.js';
import { log } from '../logger.js';

const PSA_BASE = process.env.PSA_API_BASE ?? 'https://api.psacard.com/publicapi';
const TOKEN = process.env.PSA_API_TOKEN ?? '';

export const psaConfigured = () => TOKEN.length > 0;

export interface PopulationRow {
  specId?: number | null;
  total?: number | null;
  atGrade?: number | null;
  higher?: number | null;
  gemRate?: number | null;
  byGrade?: Record<string, number> | null;
  source: 'psa_api' | 'manual';
  note?: string | null;
}

async function psa(path: string): Promise<any> {
  if (!psaConfigured()) throw new Error('PSA_API_TOKEN is not set');
  const res = await fetch(`${PSA_BASE}${path}`, {
    headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(20_000),
  });
  if (res.status === 401 || res.status === 403) {
    throw new Error(`PSA rejected the token (${res.status}) — check eligibility for the public API`);
  }
  if (!res.ok) throw new Error(`PSA ${res.status} ${res.statusText}`);
  return res.json();
}

/**
 * Parse PSA's population shape into ours.
 *
 * Exported and pure so the mapping is testable without a token: the field names are the
 * part most likely to change, and a silent mis-map would look like real data.
 */
export function parsePopulation(payload: any, grade: number | null): PopulationRow {
  const p = payload?.PSAPopulation ?? payload?.population ?? payload ?? {};
  const byGrade: Record<string, number> = {};
  for (let g = 1; g <= 10; g++) {
    const v = p[`Grade${g}`] ?? p[`grade${g}`];
    if (v != null && Number.isFinite(Number(v))) byGrade[String(g)] = Number(v);
  }
  const half = p.Grade9Half ?? p.grade9Half;
  if (half != null && Number.isFinite(Number(half))) byGrade['9.5'] = Number(half);

  const total = num(p.Total ?? p.total);
  const tenCount = byGrade['10'] ?? null;
  const atGrade = grade != null ? (byGrade[String(grade)] ?? null) : null;

  // "Higher" means strictly above this card's grade, which is the number that actually
  // matters to a seller: a PSA 9 with 400 tens above it is a different proposition.
  let higher: number | null = null;
  if (grade != null) {
    higher = Object.entries(byGrade)
      .filter(([g]) => Number(g) > grade)
      .reduce((sum, [, n]) => sum + n, 0);
  }

  return {
    specId: num(p.SpecID ?? p.specID ?? p.specId),
    total,
    atGrade,
    higher,
    gemRate: total && tenCount != null && total > 0 ? round(tenCount / total, 4) : null,
    byGrade: Object.keys(byGrade).length ? byGrade : null,
    source: 'psa_api',
  };
}

/** Fetch and store population for one SKU. Needs a spec id, or a cert to look one up. */
export async function refreshPopulation(skuId: number, opts: { specId?: number; certNumber?: string } = {}) {
  const sku = await one<{ grade: number | null; grader: string | null; spec: number | null }>(
    `SELECT s.grade, s.grader, pp.psa_spec_id AS spec
       FROM skus s LEFT JOIN psa_population pp ON pp.sku_id = s.id
      WHERE s.id = $1`, [skuId]);
  if (!sku) return { ok: false, reason: 'no such sku' };
  if (!sku.grader || !/^psa$/i.test(sku.grader)) {
    // Population is meaningful for PSA-graded cards. For a raw card it is a fact about
    // other people's copies, and storing it against this SKU would imply otherwise.
    return { ok: false, reason: 'not a PSA-graded SKU' };
  }

  let specId = opts.specId ?? sku.spec ?? null;
  try {
    if (!specId && opts.certNumber) {
      const cert = await psa(`/cert/GetByCertNumber/${encodeURIComponent(opts.certNumber)}`);
      specId = num(cert?.PSACert?.SpecID ?? cert?.SpecID);
    }
    if (!specId) return { ok: false, reason: 'no spec id — pass certNumber or specId once' };

    const row = parsePopulation(await psa(`/pop/GetPSASpecPopulation/${specId}`), sku.grade);
    await storePopulation(skuId, { ...row, specId });
    return { ok: true, ...row, specId };
  } catch (e: any) {
    log.warn({ skuId, err: e.message }, 'PSA population fetch failed');
    return { ok: false, reason: e.message };
  }
}

export async function storePopulation(skuId: number, row: PopulationRow) {
  await q(
    `INSERT INTO psa_population
       (sku_id, psa_spec_id, population_total, population_grade, population_higher,
        gem_rate, by_grade, source, checked_at, note)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now(),$9)
     ON CONFLICT (sku_id) DO UPDATE SET
       psa_spec_id = COALESCE(EXCLUDED.psa_spec_id, psa_population.psa_spec_id),
       population_total = EXCLUDED.population_total,
       population_grade = EXCLUDED.population_grade,
       population_higher = EXCLUDED.population_higher,
       gem_rate = EXCLUDED.gem_rate, by_grade = EXCLUDED.by_grade,
       source = EXCLUDED.source, checked_at = now(), note = EXCLUDED.note`,
    [skuId, row.specId ?? null, row.total ?? null, row.atGrade ?? null, row.higher ?? null,
     row.gemRate ?? null, row.byGrade ? JSON.stringify(row.byGrade) : null,
     row.source, row.note ?? null],
  );
}

/**
 * A sentence a person can act on, or null when we genuinely don't know.
 *
 * Note what it deliberately does not say: that a low population makes the card valuable.
 * It reports the counts and the one derived figure that is hard to misread — how many
 * copies grade higher than yours.
 */
export function describePopulation(p: {
  population_total?: number | null; population_grade?: number | null;
  population_higher?: number | null; gem_rate?: number | null; grade?: number | null;
} | null): string | null {
  if (!p || p.population_total == null) return null;
  const bits: string[] = [`${p.population_total} graded by PSA in total`];
  if (p.population_grade != null && p.grade != null) {
    bits.push(`${p.population_grade} at ${p.grade}`);
  }
  if (p.population_higher != null) {
    bits.push(p.population_higher === 0 ? 'none higher' : `${p.population_higher} higher`);
  }
  if (p.gem_rate != null) bits.push(`${(p.gem_rate * 100).toFixed(0)}% gem rate`);
  return bits.join(' · ')
    + '. Population is context, not scarcity: a low count can mean rare, unpopular, new, '
    + 'or simply not worth grading.';
}

const num = (v: unknown): number | null => {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const round = (v: number, dp: number) => Math.round(v * 10 ** dp) / 10 ** dp;
