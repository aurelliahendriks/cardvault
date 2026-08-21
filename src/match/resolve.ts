import { q, one } from '../db.js';
import { log } from '../logger.js';
import { llmAdjudicate } from './llmMatch.js';
import { parseTitle, printRunFromParallelName, type ParsedTitle } from './titleParse.js';
import { productShort } from '../products.js';

export interface MatchResult {
  skuId: number | null;
  method: 'exact_num' | 'trgm' | 'embedding' | 'llm' | 'manual' | 'none';
  confidence: number;
  parsed: ParsedTitle;
  rejectReason: string | null;
  /** human-readable trail, stored for auditing bad comps */
  trail: string[];
  /**
   * The card the title resolved to, even when no SKU was returned.
   *
   * Set in read-only mode, where the match succeeded but the SKU that would represent it
   * does not exist yet. The caller decides whether to create it.
   */
  cardId?: number | null;
  /** In read-only mode: true when accepting this match would create a new SKU. */
  wouldCreateSku?: boolean;
  /**
   * The parallel this title names, as the CHECKLIST spells it — `Blue (#/199)`, not `blue`.
   *
   * The distinction matters enormously to whoever is reviewing. "This card exists, its parallel
   * exists, only the SKU row has never been created" is bookkeeping, and can be accepted
   * without a thought. "This names a parallel nobody has recorded" is new reference data, and
   * deserves a human. Both previously arrived as the same "not on the checklist" message,
   * which made 32 perfectly ordinary insert parallels look like 32 decisions.
   *
   * Null means either no parallel was named, or one was named and did not match anything.
   * `parallelNamed` separates those.
   */
  parallelName?: string | null;
  /** True when the title named a parallel or print run at all. */
  parallelNamed?: boolean;
}

export interface ResolveOpts {
  allowLlm?: boolean;
  /**
   * Whether a matched title may create the SKU it names. Default true, which is right for
   * ingest: a comp for a parallel nobody has recorded still has to be storable, and the
   * alternative is dropping the sale.
   *
   * Set false for anything a human is about to review. Parsing a paste is a *question*, and
   * a question must not leave rows behind — otherwise a typo like `#91 ronaldo mango /37`
   * permanently invents a parallel, and the read-only promise the review step is built on
   * is not true.
   */
  createMissingSku?: boolean;
}

interface CardCandidate {
  card_id: number;
  legacy_id: string;
  product_code: string;
  section: string;
  card_number: string;
  player: string;
  team: string | null;
  subset: string;
  sim: number;
}

/**
 * Player-name similarity, expecting `$2` to be the parsed player guess.
 *
 * `word_similarity` is the important half: it scores how well the needle matches
 * *any portion* of the target, so a title that only says "Yamal" still scores
 * high against "Lamine Yamal". Plain `similarity` on its own drops surname-only
 * titles below threshold, which is a large share of real listings.
 */
const PLAYER_SIM = `GREATEST(
  similarity(unaccent(lower(c.player)), unaccent(lower($2))),
  word_similarity(unaccent(lower($2)), unaccent(lower(c.player))),
  word_similarity(unaccent(lower(c.player)), unaccent(lower($2)))
)`;

const CONF_ACCEPT = 0.82;   // above this: accept without asking the model
const CONF_LLM = 0.32;      // between CONF_LLM and CONF_ACCEPT: worth a model call.
                            // Set low deliberately: partial names ("Messi Kaboom",
                            // no card number) score badly on trigrams but are
                            // trivial for a model to resolve, and dropping them
                            // silently loses the best comps on the best cards.

/**
 * Resolve a listing title to a SKU.
 *
 * Three tiers, cheapest first:
 *   1. card number + player surname  -> near-certain, free
 *   2. trigram similarity shortlist  -> free, good on typos and name order
 *   3. LLM adjudication of the top-5 -> costs tokens, only for genuine ambiguity
 *
 * A listing that resolves to a card still needs its parallel and grade resolved
 * to become a SKU; that part is deterministic.
 */
export async function resolveListing(
  title: string,
  opts: ResolveOpts = {},
): Promise<MatchResult> {
  const parsed = parseTitle(title);
  const trail: string[] = [];
  // One local binding rather than a check at each of the five accept sites: a new accept
  // path added later inherits the read-only guarantee instead of quietly escaping it.
  const mayCreate = opts.createMissingSku !== false;
  const toSku = async (card: CardCandidate | { card_id: number; product_code: string; section: string })
      : Promise<{ skuId: number | null; parallelName: string | null }> =>
    mayCreate
      ? { skuId: await resolveSku(card, parsed), parallelName: null }
      : lookupSku(card, parsed);
  const named = parsed.parallelHints.length > 0 || parsed.printRun != null;

  if (parsed.reject) {
    return { skuId: null, method: 'none', confidence: 0, parsed, rejectReason: parsed.reject, trail: ['hard reject'] };
  }

  // --- tier 1: card number + surname ------------------------------------
  let candidates: CardCandidate[] = [];

  if (parsed.cardNumber) {
    const numOnly = parsed.cardNumber.replace(/^[A-Z]+-?/, '');
    // Deliberately NOT filtered by product: both sets are Panini World Cup
    // products, so a title saying "Panini FIFA World Cup" does not tell you
    // which one. Filtering here silently threw away every correct match for
    // cards that live in the Donruss set. Product is scored, never filtered.
    candidates = await q<CardCandidate>(
      `SELECT c.id AS card_id, c.legacy_id, c.product_code, c.section, c.card_number,
              c.player, c.team, c.subset,
              ${PLAYER_SIM} AS sim
         FROM cards c
        WHERE c.card_number = $1
        ORDER BY sim DESC LIMIT 20`,
      [numOnly, parsed.playerGuess || parsed.normalized],
    );
    trail.push(`num=${numOnly} -> ${candidates.length} candidates`);

    // Among same-number candidates, prefer the one the rest of the title agrees
    // with rather than blindly taking the best name similarity.
    candidates.sort((a, b) => scoreCandidate(b, parsed) - scoreCandidate(a, parsed));

    const top = candidates[0];
    if (top && top.sim >= 0.45) {
      // Number matched AND the surname is recognisable: this is as good as it gets.
      const sectionOk = parsed.sectionHints.length === 0 || parsed.sectionHints.includes(top.section);
      const conf = Math.min(0.98, 0.72 + top.sim * 0.25 + (sectionOk ? 0.05 : -0.15));
      if (conf >= CONF_ACCEPT) {
        const hit = await toSku(top);
        trail.push(`exact_num accept conf=${conf.toFixed(2)}`);
        return { skuId: hit.skuId, method: 'exact_num', confidence: round3(conf), parsed,
                 rejectReason: null, trail, cardId: top.card_id,
                 wouldCreateSku: hit.skuId == null, parallelName: hit.parallelName,
                 parallelNamed: named };
      }
    }
  }

  // --- tier 2: trigram over the denormalized search text ----------------
  const searchNeedle = [parsed.playerGuess, parsed.sectionHints[0] ?? '', parsed.cardNumber ?? '']
    .filter(Boolean).join(' ');

  if (searchNeedle.length >= 3) {
    // Match on the player name rather than the whole search_text: the checklist
    // text carries the set name and section, which dilute the trigram score
    // against a short needle and push the right card below the noise.
    const needle = parsed.playerGuess || searchNeedle;
    const trgm = await q<CardCandidate>(
      `SELECT c.id AS card_id, c.legacy_id, c.product_code, c.section, c.card_number,
              c.player, c.team, c.subset,
              GREATEST(
                similarity(unaccent(lower(c.player)), unaccent(lower($1))),
                word_similarity(unaccent(lower($1)), unaccent(lower(c.player))),
                word_similarity(unaccent(lower(c.player)), unaccent(lower($1))),
                similarity(unaccent(lower(c.search_text)), unaccent(lower($2))) * 0.9
              ) AS sim
         FROM cards c
        WHERE similarity(unaccent(lower(c.player)), unaccent(lower($1))) > 0.28
           OR word_similarity(unaccent(lower($1)), unaccent(lower(c.player))) > 0.45
           OR similarity(unaccent(lower(c.search_text)), unaccent(lower($2))) > 0.28
        ORDER BY sim DESC LIMIT 20`,
      [needle, searchNeedle],
    );

    // merge, preferring any tier-1 hit
    const seen = new Set(candidates.map((c) => c.card_id));
    for (const t of trgm) if (!seen.has(t.card_id)) candidates.push(t);
    trail.push(`trgm "${searchNeedle}" -> ${trgm.length}`);
  }

  if (candidates.length === 0) {
    return { skuId: null, method: 'none', confidence: 0, parsed, rejectReason: 'no_candidate', trail };
  }

  candidates.sort((a, b) => scoreCandidate(b, parsed) - scoreCandidate(a, parsed));
  const best = candidates[0]!;
  const bestScore = scoreCandidate(best, parsed);
  const second = candidates[1] ? scoreCandidate(candidates[1], parsed) : 0;
  const margin = bestScore - second;

  trail.push(`best=${best.legacy_id} score=${bestScore.toFixed(2)} margin=${margin.toFixed(2)}`);

  /**
   * Unique (player, section) accept.
   *
   * "Lionel Messi Kaboom" has no card number, so it scores poorly on structure —
   * but there is exactly one Messi Kaboom in the entire checklist. The pair has
   * already identified the card; the missing "#1" adds nothing. This is a
   * decisive rule rather than a score bonus because scoring it as a nudge left
   * every such listing parked just under the threshold, quietly discarding the
   * best comps on the most valuable cards in the set.
   *
   * Confidence is capped below the exact-number path: no card number confirmed it.
   */
  if (parsed.sectionHints.length && best.sim >= 0.85) {
    const rivals = candidates.filter(
      (c) => c.sim >= 0.85 && parsed.sectionHints.includes(c.section),
    );
    if (rivals.length === 1 && rivals[0]!.card_id === best.card_id) {
      trail.push('unique (player, section) pair in checklist -> accept');
      const hit = await toSku(best);
      return { skuId: hit.skuId, method: 'trgm', confidence: 0.88, parsed, rejectReason: null,
               trail, cardId: best.card_id, wouldCreateSku: hit.skuId == null,
               parallelName: hit.parallelName, parallelNamed: named };
    }
  }

  if (bestScore >= CONF_ACCEPT && margin >= 0.08) {
    const hit = await toSku(best);
    return { skuId: hit.skuId, method: 'trgm', confidence: round3(bestScore), parsed,
             rejectReason: null, trail, cardId: best.card_id, wouldCreateSku: hit.skuId == null,
             parallelName: hit.parallelName, parallelNamed: named };
  }

  // --- tier 3: let the model break the tie ------------------------------
  if (opts.allowLlm !== false && bestScore >= CONF_LLM) {
    const verdict = await llmAdjudicate(title, candidates.slice(0, 5));
    if (verdict) {
      trail.push(`llm -> ${verdict.legacyId ?? 'none'} conf=${verdict.confidence}`);
      if (verdict.reject) {
        return { skuId: null, method: 'llm', confidence: verdict.confidence, parsed, rejectReason: verdict.reject, trail };
      }
      const chosen = candidates.find((c) => c.legacy_id === verdict.legacyId);
      if (chosen && verdict.confidence >= 0.7) {
        const hit = await toSku(chosen);
        return { skuId: hit.skuId, method: 'llm', confidence: verdict.confidence, parsed,
                 rejectReason: null, trail, cardId: chosen.card_id,
                 wouldCreateSku: hit.skuId == null, parallelName: hit.parallelName,
                 parallelNamed: named };
      }
    }
  }

  return {
    skuId: null, method: 'none', confidence: round3(bestScore), parsed,
    rejectReason: 'low_conf', trail,
  };
}

// ---------------------------------------------------------------------------

function scoreCandidate(c: CardCandidate, p: ParsedTitle): number {
  let s = 0;

  // player-name similarity is the backbone
  s += Math.min(1, c.sim) * 0.5;

  // Card-number agreement is very strong evidence — but only punish a mismatch
  // hard when the seller actually wrote "#214". A bare number we inferred from
  // the title could be anything.
  if (p.cardNumber) {
    const numOnly = p.cardNumber.replace(/^[A-Z]+-?/, '');
    if (c.card_number === numOnly) s += p.cardNumberIsExplicit ? 0.32 : 0.22;
    else s -= p.cardNumberIsExplicit ? 0.28 : 0.06;
  }

  // Section agreement. Named inserts are strong evidence in both directions:
  // a title saying "Kaboom!" is not a base card, and a title naming no insert
  // usually is one.
  if (p.sectionHints.length) {
    if (p.sectionHints.includes(c.section)) s += 0.18;
    else s -= 0.16;
  } else if (/^base$/i.test(c.section)) {
    s += 0.06;                      // no insert named -> base is the prior
  } else if (!/^base/i.test(c.section)) {
    s -= 0.04;
  }

  // Product agreement, weighted by how confidently the title names a product.
  // "Donruss" is decisive; "Panini World Cup" is not, because both sets are
  // Panini World Cup products.
  if (p.productHints.length) {
    if (p.productHints.includes(c.product_code)) s += p.productHintStrong ? 0.12 : 0.03;
    else s -= p.productHintStrong ? 0.22 : 0.03;
  }

  // an auto in the title should land on an autograph section
  const autoSection = /autograph|signature/i.test(c.section);
  if (p.isAuto && !autoSection) s -= 0.18;
  if (!p.isAuto && autoSection) s -= 0.10;

  // rated-rookie agreement
  if (p.isRookie && c.subset === 'RR') s += 0.06;

  // team named in the title
  if (c.team && new RegExp(`\\b${escapeRe(c.team)}\\b`, 'i').test(p.normalized)) s += 0.05;

  // The structure multiplier used to be 0.6 + 0.4*structure, which meant a title
  // with strong player and section evidence but no card number could never clear
  // the accept threshold. Damped so missing structure is a discount, not a veto.
  return Math.max(0, Math.min(1, s * (0.78 + 0.22 * p.structureScore)));
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const round3 = (n: number) => Math.round(n * 1000) / 1000;

/**
 * The read-only twin of `resolveSku`: find the SKU this title names, or return null.
 *
 * Never inserts. Two consequences worth stating, because both are intended:
 *
 * - A parallel that is not on the checklist returns null even though the *card* matched
 *   confidently. That is the correct answer to "does this SKU exist" and the caller gets
 *   `cardId` and `wouldCreateSku` to act on it.
 * - The unnamed-parallel fallback (`Unidentified /37`) is skipped entirely. Inventing that
 *   row is a reasonable trade when ingesting a sale that would otherwise be lost; it is
 *   never reasonable while somebody is still looking at the screen deciding.
 *
 * Parallel matching is deliberately the same scoring as `resolveSku` rather than a stricter
 * equality test, so read-only and creating modes agree on which parallel a title means. If
 * they disagreed, review would show one thing and commit would write another.
 */
async function lookupSku(
  card: CardCandidate | { card_id: number; product_code: string; section: string },
  p: ParsedTitle,
): Promise<{ skuId: number | null; parallelName: string | null }> {
  let parallelId: number | null = null;
  let parallelName: string | null = null;

  if (p.parallelHints.length || p.printRun) {
    parallelId = await bestParallel(card.product_code, card.section, p);
    if (parallelId != null) {
      // Report the checklist's own spelling. The caller commits with THIS name, not the typed
      // hint — otherwise `resolveOrCreateSku`, which matches parallels by exact name, would
      // fail to find "Blue (#/199)" from "Blue" and create a duplicate "Blue" alongside it.
      const par = await one<{ name: string }>(`SELECT name FROM parallels WHERE id = $1`, [parallelId]);
      parallelName = par?.name ?? null;
    } else {
      // Named or numbered, and nothing on the checklist matches: there is no SKU to find, and
      // accepting this would mean declaring a parallel.
      return { skuId: null, parallelName: null };
    }
  }

  const row = await one<{ id: number }>(
    `SELECT id FROM skus
      WHERE card_id = $1
        AND parallel_id IS NOT DISTINCT FROM $2
        AND grader IS NOT DISTINCT FROM $3
        AND grade  IS NOT DISTINCT FROM $4`,
    [card.card_id, parallelId, p.grader, p.grade],
  );
  return { skuId: row?.id ?? null, parallelName };
}

/**
 * Which declared parallel does this title mean?
 *
 * Name-similarity against the parallels declared for that (product, section), with the
 * print run as a tiebreaker: a title saying "/10" should land on the /10 parallel even if
 * the colour word is missing, and a title whose colour matches but whose run contradicts
 * the checklist is penalised rather than accepted.
 */
async function bestParallel(productCode: string, section: string, p: ParsedTitle): Promise<number | null> {
  const pars = await q<{ id: number; name: string; print_run: number | null; aliases: string[] }>(
    `SELECT id, name, print_run, aliases FROM parallels
      WHERE product_code = $1 AND section = $2`,
    [productCode, section],
  );

  let bestId: number | null = null;
  let bestScore = 0;
  for (const par of pars) {
    const parLow = par.name.toLowerCase();
    let sc = 0;
    for (const hint of p.parallelHints) {
      if (parLow.includes(hint)) sc = Math.max(sc, 0.5 + hint.length / 60);
      for (const al of par.aliases ?? []) {
        if (al.toLowerCase().includes(hint)) sc = Math.max(sc, 0.5);
      }
    }
    const run = par.print_run ?? printRunFromParallelName(par.name);
    if (p.printRun && run === p.printRun) sc += 0.4;
    else if (p.printRun && run != null && run !== p.printRun) sc -= 0.3;
    if (sc > bestScore) { bestScore = sc; bestId = par.id; }
  }
  return bestScore >= 0.45 ? bestId : null;
}

/**
 * Card + parsed parallel/grade -> SKU id, creating the SKU if it's new.
 * Parallel resolution is name-similarity against the parallels declared for
 * that (product, section), with the print run as a tiebreaker: a title saying
 * "/10" should land on the /10 parallel even if the colour word is missing.
 */
export async function resolveSku(card: CardCandidate | { card_id: number; product_code: string; section: string }, p: ParsedTitle): Promise<number> {
  let parallelId: number | null = null;

  if (p.parallelHints.length || p.printRun) {
    // Shared with `lookupSku` on purpose — see the note there.
    parallelId = await bestParallel(card.product_code, card.section, p);

    // A numbered card whose parallel we can't name is still not the base card —
    // record an ad-hoc parallel so its comps don't pollute base pricing.
    if (parallelId == null && p.printRun) {
      const name = `Unidentified /${p.printRun}`;
      const row = await one<{ id: number }>(
        `INSERT INTO parallels (product_code, section, name, print_run, fallback_mult)
         VALUES ($1,$2,$3,$4,NULL)
         ON CONFLICT (product_code, section, name) DO UPDATE SET name = EXCLUDED.name
         RETURNING id`,
        [card.product_code, card.section, name, p.printRun],
      );
      parallelId = row?.id ?? null;
    }
  }

  const label = await buildLabel(card.card_id, parallelId, p.grader, p.grade);
  const row = await one<{ id: number }>(
    `INSERT INTO skus (card_id, parallel_id, grader, grade, label)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (card_id, parallel_id, grader, grade) DO UPDATE SET label = EXCLUDED.label
     RETURNING id`,
    [card.card_id, parallelId, p.grader, p.grade, label],
  );
  return row!.id;
}

async function buildLabel(cardId: number, parallelId: number | null, grader: string | null, grade: number | null): Promise<string> {
  const c = await one<{ player: string; card_number: string; section: string; product_code: string }>(
    `SELECT player, card_number, section, product_code FROM cards WHERE id = $1`, [cardId],
  );
  const par = parallelId
    ? await one<{ name: string }>(`SELECT name FROM parallels WHERE id = $1`, [parallelId])
    : null;
  const bits = [
    productShort(c?.product_code),
    c?.section,
    `#${c?.card_number}`,
    c?.player,
    par?.name,
    grader ? `${grader} ${grade ?? '?'}` : 'Raw',
  ].filter(Boolean);
  return bits.join(' · ');
}

/** Ensure the plain raw/base SKU exists for a card — used by seeding and the UI. */
export async function baseSkuFor(cardId: number): Promise<number> {
  const existing = await one<{ id: number }>(
    `SELECT id FROM skus WHERE card_id = $1 AND parallel_id IS NULL AND grader IS NULL AND grade IS NULL`,
    [cardId],
  );
  if (existing) return existing.id;
  const label = await buildLabel(cardId, null, null, null);
  const row = await one<{ id: number }>(
    `INSERT INTO skus (card_id, parallel_id, grader, grade, label) VALUES ($1,NULL,NULL,NULL,$2)
       ON CONFLICT (card_id, parallel_id, grader, grade) DO UPDATE SET label = EXCLUDED.label
       RETURNING id`,
    [cardId, label],
  );
  return row!.id;
}
