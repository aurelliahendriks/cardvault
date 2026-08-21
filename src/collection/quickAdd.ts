/**
 * Bulk entry: one line per card, typed the way you would say it out loud.
 *
 *   mora 214 x2 @4.50
 *   messi kaboom psa 10
 *   yamal base gold /10 @340
 *   #91 ronaldo teal
 *
 * The reason this works at all is that the hard part is already built. `resolveListing()`
 * exists to match messy eBay titles — surname-only, wrong order, missing set name, accents
 * stripped — to a checklist row, and it is the single most tested thing in the codebase. A
 * person typing from a stack of cards produces input of exactly that shape, so entry can
 * reuse the matcher rather than demanding a tidy form per card.
 *
 * What this file adds is the two things a listing title never contains: how many you have,
 * and what you paid. Those are stripped off the line before matching, because leaving `x2`
 * or `@4.50` in the string actively confuses the parser — `x2` looks like nothing, and
 * `4.50` can be read as a card number.
 *
 * Nothing here writes. Parsing and committing are separate calls on purpose: a matcher
 * that is right 90% of the time is excellent for pricing (a wrong comp gets excluded) and
 * unacceptable for data entry (a wrong holding is silent and permanent). So every line
 * comes back with its confidence and what it matched, and the human confirms.
 */

import { one, q } from '../db.js';
import { resolveListing } from '../match/resolve.js';
import { parseTitle } from '../match/titleParse.js';
import { productShortSql } from '../products.js';

/** A card the line might be, when no SKU matched outright. */
export interface CardChoice {
  cardId: number;
  label: string;
  /** Similarity on the player name, so the UI can order and caption honestly. */
  sim: number;
}

export interface ParsedLine {
  line: number;
  raw: string;
  /** What was left after quantity and price were stripped, i.e. what got matched. */
  query: string;
  qty: number;
  paidAud: number | null;
  /** Present when a grade was typed, so the SKU resolves to the slab, not the raw card. */
  grader: string | null;
  grade: string | null;
  parallelName: string | null;
  printRun: number | null;
  skuId: number | null;
  label: string | null;
  cardId: number | null;
  confidence: number;
  method: string;
  /** 'ok' needs no attention; 'review' matched weakly; 'unmatched' found nothing. */
  status: 'ok' | 'review' | 'unmatched';
  reason: string | null;
  /** Other plausible cards, so a wrong match can be corrected without retyping. */
  alternatives: Array<{ skuId: number; label: string; valueAud: number | null }>;
  /**
   * Candidate cards when no SKU matched. Populated for the case that matters most: a
   * numbered parallel that is not on the checklist. The card exists, the SKU does not
   * yet, and committing one of these creates it.
   */
  cardChoices: CardChoice[];
  /** True when committing this row will declare a parallel the checklist does not have. */
  createsParallel: boolean;
  /**
   * True when the card AND its parallel are both on the checklist and only the SKU row is
   * missing. Purely mechanical, so these are accepted without asking.
   */
  createsSku: boolean;
}

/** Above this, a match is presented as settled. Below, it is presented for review. */
const ACCEPT = 0.8;

/**
 * Reject codes in plain English.
 *
 * The codes are the matcher's vocabulary, aimed at auditing comps. Printing `no_candidate`
 * or `break_slot` in a review table tells the person nothing about what to do next, which is
 * the only thing the row is there to say. Each of these ends in an action.
 */
const WHY: Record<string, string> = {
  no_candidate: 'no card in either checklist looks like this — check the spelling, or add the card number',
  low_conf: 'too many cards fit — add the card number or the set name',
  lot: 'this reads as a lot or bundle; enter the cards separately',
  sealed_product: 'this reads as sealed product, not a single card',
  break_slot: 'this reads as a break slot rather than a card you own',
  reprint: 'this reads as a reprint or novelty, which the checklist does not cover',
  custom: 'this reads as a custom or art card — use "add a card the checklist does not have"',
  digital: 'this reads as a digital card',
  sticker: 'this reads as a sticker rather than a trading card',
  empty_holder: 'this reads as an empty holder or slab',
  not_a_card: 'this does not read as a card at all',
};

/**
 * Pull quantity and price out of a line.
 *
 * Both are unambiguous in practice: quantity is `x2`, `×2`, `2x` or a bare `qty 2`, price
 * is `@4.50` or `$4.50`. A bare number is left alone — it is far more likely to be a card
 * number, and guessing wrong there costs a mismatched card.
 */
export function extractQtyAndPrice(raw: string): { query: string; qty: number; paidAud: number | null } {
  let s = ` ${raw.trim()} `;
  let qty = 1;
  let paid: number | null = null;

  // Price first: `@12.50`, `$12.50`, `paid 12.50`. Anchored to a symbol or a word so a
  // print run (`/49`) or a card number can never be read as money.
  const priceMatch = /[\s](?:@|\$|paid\s+|cost\s+)(\d+(?:[.,]\d{1,2})?)[\s]/i.exec(s);
  if (priceMatch) {
    paid = Number(priceMatch[1]!.replace(',', '.'));
    s = s.replace(priceMatch[0], ' ');
  }

  // Quantity: x2 / ×2 / 2x / qty 2. Not a bare digit.
  const qtyMatch = /[\s](?:[x×]\s?(\d{1,3})|(\d{1,3})\s?[x×]|qty\s+(\d{1,3}))[\s]/i.exec(s);
  if (qtyMatch) {
    qty = Number(qtyMatch[1] ?? qtyMatch[2] ?? qtyMatch[3]);
    s = s.replace(qtyMatch[0], ' ');
  }

  return {
    query: s.replace(/\s+/g, ' ').trim(),
    qty: Number.isFinite(qty) && qty > 0 ? Math.min(qty, 999) : 1,
    paidAud: paid != null && Number.isFinite(paid) && paid > 0 ? paid : null,
  };
}

/**
 * Turn the parser's parallel words into a name worth storing.
 *
 * Two fixes. Order: `parallelHints` comes back in match order, not reading order, so
 * "blue holo" arrives as `["holo","blue"]` and would be stored as "Holo Blue". Case: hints
 * are lowercased, and the checklist spells parallels "Teal", "Gold Laser". A declared
 * parallel that reads like the printed ones can later be reconciled with the checklist;
 * "holo blue" would sit there forever as a separate thing.
 */
export function parallelNameFrom(hints: string[], query: string): string | null {
  if (!hints.length) return null;
  const lower = query.toLowerCase();
  const ordered = [...new Set(hints.map((h) => h.toLowerCase()))]
    .sort((a, b) => {
      const ia = lower.indexOf(a), ib = lower.indexOf(b);
      return (ia < 0 ? 1e9 : ia) - (ib < 0 ? 1e9 : ib);
    });
  return ordered.join(' ').replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

/**
 * Which cards could this line be, when the SKU matcher declined?
 *
 * This is the single most important thing in the file, because of *why* the matcher
 * declines. It resolves to a SKU, and a SKU for a numbered parallel only exists if the
 * parallel is on the checklist. The cards a collector most wants recorded — the /49, the
 * /10, the one-of-one — are exactly the ones most likely to be missing from it, so the
 * strict path rejects the valuable half of a shoebox and accepts the base cards.
 *
 * The card, though, is never in doubt: "yamal base blue /49" names a player and a section
 * that exist. So fall back to matching the *card* and let the human confirm, which is what
 * `resolveOrCreateSku` is already built to accept — it declares the parallel on commit and
 * logs that it did.
 *
 * Deliberately capped and ordered by name similarity: a list of six is a decision, a list
 * of forty is a search box, and a search box is the thing bulk entry exists to avoid.
 */
async function cardCandidates(
  playerGuess: string,
  sectionHints: string[],
  cardNumber: string | null,
  matchedCardId: number | null,
) {
  if ((!playerGuess || playerGuess.length < 3) && !cardNumber) {
    return matchedCardId ? cardsByIds([matchedCardId]) : [];
  }
  const rows = await q<CardChoice>(
    `SELECT c.id AS "cardId",
            ${productShortSql()}
              || ' · ' || c.section || ' · #' || c.card_number || ' · ' || c.player AS label,
            GREATEST(
              similarity(unaccent(lower(c.player)), unaccent(lower($1))),
              word_similarity(unaccent(lower($1)), unaccent(lower(c.player)))
            )::float AS sim
       FROM cards c
      WHERE (similarity(unaccent(lower(c.player)), unaccent(lower($1))) > 0.3
             OR word_similarity(unaccent(lower($1)), unaccent(lower(c.player))) > 0.5
             -- A typed card number RETRIEVES, it does not merely sort. Leaving it out of
             -- the WHERE clause meant a line with a noisy name lost the card it had
             -- identified exactly: "#91 ronaldo <noise>" scored 'Cristiano Ronaldo' below
             -- the similarity floor and offered a different Ronaldo instead.
             OR ($3::text IS NOT NULL AND c.card_number = $3))
      ORDER BY
        -- A typed section or card number is a strong signal even when the SKU did not
        -- resolve, so let it outrank raw name similarity. Exact section beats a section
        -- that merely starts the same, or "base" offers "Base Optic" first.
        (CASE WHEN $3::text IS NOT NULL AND c.card_number = $3 THEN 1 ELSE 0 END) DESC,
        (CASE WHEN $2::text[] <> '{}' AND lower(c.section) = ANY(
                 SELECT lower(x) FROM unnest($2::text[]) AS x) THEN 1 ELSE 0 END) DESC,
        sim DESC,
        -- Deterministic, so the same paste always offers the same order.
        c.id ASC
      LIMIT 6`,
    [playerGuess, sectionHints, cardNumber],
  );

  // The matcher's own pick leads, and is added if similarity missed it — it got there with
  // more evidence than a name trigram (card number, section agreement, sometimes the model).
  if (matchedCardId != null) {
    const hit = rows.find((r) => r.cardId === matchedCardId);
    if (hit) return [hit, ...rows.filter((r) => r !== hit)];
    const [extra] = await cardsByIds([matchedCardId]);
    if (extra) return [extra, ...rows.slice(0, 5)];
  }
  return rows;
}

/** Label a known card id the same way the candidate list does. */
function cardsByIds(ids: number[]) {
  return q<CardChoice>(
    `SELECT c.id AS "cardId",
            ${productShortSql()}
              || ' · ' || c.section || ' · #' || c.card_number || ' · ' || c.player AS label,
            1::float AS sim
       FROM cards c WHERE c.id = ANY($1)`,
    [ids],
  );
}

/**
 * Parse a block of lines. Reads the database; writes nothing.
 *
 * `allowLlm` is off by default even when a key is configured: a 200-line paste would be
 * 200 model calls, and the deterministic tiers handle the overwhelming majority of
 * human-typed input. Turn it on for the leftovers.
 */
export async function parseQuickAdd(
  text: string,
  opts: { allowLlm?: boolean } = {},
): Promise<{ lines: ParsedLine[]; summary: Record<string, number> }> {
  // A comment is `//…` or a hash followed by SPACE. A hash followed by anything else is a
  // card number — `#91 ronaldo teal`, `#PR-05 yamal` — which is how the placeholder tells
  // people to type. Treating every `#` line as a comment silently dropped exactly the lines
  // that had used the most precise identifier available.
  const rawLines = text.split(/\r?\n/).map((l) => l.trim())
    .filter((l) => l && !/^#\s/.test(l) && !l.startsWith('//'));

  const lines: ParsedLine[] = [];
  for (const [i, raw] of rawLines.entries()) {
    const { query, qty, paidAud } = extractQtyAndPrice(raw);
    const parsed = parseTitle(query);
    // `createMissingSku: false` is what makes "nothing is saved yet" true. Without it the
    // matcher creates the SKU — and, for an unrecognised colour word on a numbered card, a
    // parallel — as a side effect of being asked a question.
    const m = await resolveListing(query, {
      allowLlm: opts.allowLlm === true,
      createMissingSku: false,
    });

    let label: string | null = null;
    let cardId: number | null = null;
    let value: number | null = null;
    if (m.skuId) {
      const d = await one<{ label: string; card_id: number; fair_value_aud: number | null }>(
        `SELECT d.label, d.card_id, v.fair_value_aud
           FROM sku_detail d
           LEFT JOIN latest_valuation v ON v.sku_id = d.sku_id AND v.marketplace_code IS NULL
          WHERE d.sku_id = $1`, [m.skuId]);
      label = d?.label ?? null;
      cardId = d?.card_id ?? null;
      value = d?.fair_value_aud ?? null;
    }

    // Alternatives make a wrong match cheap to fix. Same player, so the list is short and
    // relevant rather than a search box.
    const alternatives = m.skuId && cardId
      ? await q<{ skuId: number; label: string; valueAud: number | null }>(
          `SELECT s.id AS "skuId", d.label, v.fair_value_aud AS "valueAud"
             FROM skus s
             JOIN sku_detail d ON d.sku_id = s.id
             LEFT JOIN latest_valuation v ON v.sku_id = s.id AND v.marketplace_code IS NULL
            WHERE s.card_id = $1 AND s.id <> $2
            ORDER BY COALESCE(v.fair_value_aud, 0) DESC LIMIT 6`, [cardId, m.skuId])
      : [];

    const printRun = parsed.isOneOfOne ? 1 : parsed.printRun ?? null;

    /**
     * The card is known and so is the parallel; only the SKU row has never been created.
     *
     * This is bookkeeping, not a decision, so it is accepted like any other match. Getting
     * this wrong was costly: a 106-card insert collection produced 32 "confirm this" rows,
     * every one of them an ordinary `Blue (#/199)` that the checklist already lists. Asking
     * 32 times about something with one possible answer trains people to click through the
     * warnings that DO matter.
     *
     * `m.parallelName` is the checklist's own spelling, and committing with it is essential:
     * `resolveOrCreateSku` matches parallels by exact name, so committing the typed "Blue"
     * would create a second parallel next to "Blue (#/199)".
     */
    const knownParallel = !m.skuId && m.cardId != null && m.parallelNamed === true
                          && !!m.parallelName;
    const mechanical = !m.skuId && m.cardId != null
                       && (knownParallel || m.parallelNamed === false);

    // No SKU and not mechanical: name the card instead, matcher's own pick first.
    const cardChoices = (m.skuId || mechanical) ? []
      : await cardCandidates(parsed.playerGuess ?? '', parsed.sectionHints ?? [],
                             parsed.cardNumber ?? null, m.cardId ?? null);

    // Mirror what `resolveOrCreateSku` will actually name it, so the row tells the truth.
    const parallelName = m.parallelName
      ?? parallelNameFrom(parsed.parallelHints ?? [], query)
      ?? (printRun ? `Unidentified /${printRun}` : null);

    const status: ParsedLine['status'] = m.skuId
      ? (m.confidence >= ACCEPT ? 'ok' : 'review')
      : mechanical ? (m.confidence >= ACCEPT ? 'ok' : 'review')
      : cardChoices.length ? 'review' : 'unmatched';

    const reason = m.skuId
      ? (status === 'review' ? 'matched, but not confidently' : null)
      : mechanical
        ? (knownParallel ? `first one recorded as ${parallelName}` : null)
      : cardChoices.length
        ? (parallelName || printRun
            ? `not on the checklist as a parallel — pick the card and it will be created as ${
                [parallelName, printRun ? `/${printRun}` : null].filter(Boolean).join(' ')}`
            : 'pick which card this is')
        : (m.rejectReason ? WHY[m.rejectReason] ?? m.rejectReason : 'nothing matched');

    lines.push({
      line: i + 1, raw, query, qty, paidAud,
      grader: parsed.grader ?? null,
      grade: parsed.grade != null ? String(parsed.grade) : null,
      parallelName, printRun,
      skuId: m.skuId, label, cardId: cardId ?? m.cardId ?? null,
      confidence: Math.round((m.confidence ?? 0) * 100) / 100,
      method: m.method,
      status,
      reason,
      alternatives,
      cardChoices,
      createsParallel: !m.skuId && !mechanical && cardChoices.length > 0
                       && Boolean(parallelName || printRun),
      createsSku: mechanical,
    });
    void value;
  }

  // `review` covers two situations that need opposite advice — "this matched a SKU weakly,
  // check the dropdown" and "no SKU exists, pick the card and one gets made" — so they are
  // counted apart. A single number would produce a caption that is wrong half the time.
  const summary = lines.reduce<Record<string, number>>((acc, l) => {
    acc[l.status] = (acc[l.status] ?? 0) + 1;
    if (l.status === 'review') {
      if (l.skuId) acc.weak = (acc.weak ?? 0) + 1;
      else acc.needPick = (acc.needPick ?? 0) + 1;
    }
    acc.cards = (acc.cards ?? 0) + (l.status === 'unmatched' ? 0 : l.qty);
    return acc;
  }, {});
  return { lines, summary };
}
