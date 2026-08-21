import { q } from '../db.js';

/**
 * Community / channel routing.
 *
 * "Which marketplace" and "which community" are different questions. eBay AU
 * might net the most on a A$400 Kaboom, but a A$3 base Yamal that sells 2-6
 * times a day at A$2-5 is a fee-and-postage loss on eBay and a fine sale as
 * part of a player lot on Whatnot or in a Facebook group. This scores channels
 * on fit, not just price.
 */

export interface CommunityRow {
  id: number;
  name: string;
  kind: string;
  region: string | null;
  url: string | null;
  fee_pct: number;
  audience_size: number | null;
  focus_sections: string[];
  focus_teams: string[];
  min_value_aud: number;
  max_value_aud: number | null;
  likes_lots: boolean;
  likes_graded: boolean;
  speed_score: number;
  price_realization: number;
  notes: string | null;
}

export interface CommunityRank {
  id: number;
  name: string;
  kind: string;
  region: string | null;
  url: string | null;
  /** expected realized price here, AUD, after their fee */
  expectedNetAud: number;
  fitScore: number;
  speedScore: number;
  reasons: string[];
  warnings: string[];
}

export async function rankCommunities(args: {
  valueAud: number;
  section: string;
  team: string | null;
  player: string;
  isGraded: boolean;
  /** true when the sensible play is a multi-card lot rather than a single */
  suggestLot: boolean;
  /** how much urgency the timing model reports, 0..1 */
  urgency: number;
  limit?: number;
}): Promise<CommunityRank[]> {
  const rows = await q<CommunityRow>(`SELECT * FROM communities WHERE active`);
  const out: CommunityRank[] = [];

  for (const c of rows) {
    const reasons: string[] = [];
    const warnings: string[] = [];
    let fit = 0.5;

    // --- value band ------------------------------------------------------
    if (args.valueAud < Number(c.min_value_aud)) {
      warnings.push(`Below this channel's practical floor of A$${c.min_value_aud} — not worth the effort per card.`);
      fit -= 0.35;
    }
    if (c.max_value_aud != null && args.valueAud > Number(c.max_value_aud)) {
      warnings.push(`Above A$${c.max_value_aud}: the audience here gets thin and trust becomes the bottleneck.`);
      fit -= 0.30;
    }

    // --- section fit -----------------------------------------------------
    if (c.focus_sections?.length) {
      if (c.focus_sections.some((s) => s.toLowerCase() === args.section.toLowerCase())) {
        fit += 0.25;
        reasons.push(`This channel specifically moves ${args.section}.`);
      }
    }

    // --- nationality fit -------------------------------------------------
    if (c.focus_teams?.length && args.team) {
      if (c.focus_teams.some((t) => t.toLowerCase() === args.team!.toLowerCase())) {
        fit += 0.30;
        reasons.push(`Audience is concentrated on ${args.team} — nationality demand you won't get on a general marketplace.`);
      }
    }

    // --- lots ------------------------------------------------------------
    if (args.suggestLot) {
      if (c.likes_lots) { fit += 0.22; reasons.push('Takes lots well, which is the right shape for this card.'); }
      else { fit -= 0.18; warnings.push('Single-card oriented; a lot will sit here.'); }
    }

    // --- graded ----------------------------------------------------------
    if (args.isGraded) {
      if (c.likes_graded) { fit += 0.12; reasons.push('Graded-friendly audience.'); }
      else { fit -= 0.10; }
    }

    // --- urgency ---------------------------------------------------------
    if (args.urgency > 0.55) {
      fit += (Number(c.speed_score) - 0.5) * 0.5;
      if (Number(c.speed_score) >= 0.75) reasons.push('Fast-moving channel, which matters given the decay clock on this card.');
      if (Number(c.speed_score) <= 0.45) warnings.push('Slow channel — a bad match for a card that is losing value weekly.');
    }

    // --- economics -------------------------------------------------------
    const realization = Number(c.price_realization);
    const gross = args.valueAud * realization;
    const expectedNetAud = r2(gross * (1 - Number(c.fee_pct)));
    if (realization >= 1.0) {
      reasons.push(`Historically realizes ~${(realization * 100).toFixed(0)}% of eBay market at ${(Number(c.fee_pct) * 100).toFixed(1)}% fees.`);
    } else {
      reasons.push(`Realizes ~${(realization * 100).toFixed(0)}% of eBay market, but at ${(Number(c.fee_pct) * 100).toFixed(1)}% fees.`);
    }
    if (c.notes) reasons.push(c.notes);

    out.push({
      id: c.id, name: c.name, kind: c.kind, region: c.region, url: c.url,
      expectedNetAud,
      fitScore: r3(Math.max(0, Math.min(1, fit))),
      speedScore: Number(c.speed_score),
      reasons, warnings,
    });
  }

  // Rank on net proceeds weighted by fit — a channel that pays more but is a
  // bad fit will sit unsold, which is worth nothing.
  return out
    .sort((a, b) => b.expectedNetAud * (0.35 + b.fitScore) - a.expectedNetAud * (0.35 + a.fitScore))
    .slice(0, args.limit ?? 5);
}

/**
 * Should this be sold as a lot rather than a single?
 *
 * The trigger case: big-name base cards that sell 2-6 times a day at A$2-5.
 * They are the most liquid cards in the product and simultaneously worthless
 * individually once you subtract postage and the fixed per-order fee.
 */
export function shouldLot(args: { valueAud: number; salesPerDay: number | null; section: string }): { lot: boolean; why: string } {
  if (args.valueAud >= 25) return { lot: false, why: 'Worth listing on its own.' };
  const liquid = (args.salesPerDay ?? 0) >= 0.5;
  if (args.valueAud < 8) {
    return {
      lot: true,
      why: liquid
        ? 'Highly liquid but only A$2-5 a card — postage and the fixed per-order fee eat the entire sale. Bundle by player or nation into A$25+ lots.'
        : 'Too low-value to list individually; the per-order fee alone is a large share of the sale. Bundle into lots.',
    };
  }
  return {
    lot: true,
    why: 'Marginal as a single after postage. A player or team lot converts the same cards into a sale worth making.',
  };
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const r3 = (n: number) => Math.round(n * 1000) / 1000;
