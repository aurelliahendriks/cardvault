import { WC_FINAL } from '../valuation/engine.js';
import { rarityTier } from '../valuation/scores.js';

/**
 * Post-World-Cup decay model.
 *
 * The 2026 final was 19 July 2026. Every prior cycle shows the same shape:
 * tournament-driven demand decays roughly exponentially over the following
 * 6-12 months, non-icon cards give back 20-40%, and genuine icons (Messi,
 * Ronaldo) hold or keep climbing because their demand was never
 * tournament-contingent in the first place.
 *
 * Host-nation and breakout-rookie premiums decay fastest of all — they are
 * pure attention, and attention is what's leaving.
 *
 * THE SHAPE OF THE MODEL, and why it is this shape:
 *
 *     P(t) = B + H · exp(-t / τ)
 *
 *   B  the collector/fundamental baseline — what the card is worth once the
 *      tournament stops being news
 *   H  the event-hype premium sitting on top of B right now
 *   τ  how fast hype leaves, set by WHO the player is
 *
 * The tempting mistake is to give scarce cards a longer half-life: a /10 "obviously"
 * holds better than a base parallel. There is no evidence for that, and there is a
 * confound that would fake it either way — a /10 trades once every six weeks, so a
 * flat-looking price line may just be an absence of observations. Illiquidity
 * masquerades as stability.
 *
 * The defensible version says the same thing without the unsupported claim: scarcity
 * does not change how fast hype decays, it changes **how much of the price was hype in
 * the first place**. A base Yamal at A$100 might be A$55 baseline and A$45 hype; a /10
 * at A$800 might be A$700 scarcity-driven baseline and A$100 hype. Identical τ, and the
 * /10 still loses far less of its total value.
 *
 * So: player tier → τ. Card archetype and scarcity → H. And rarity widens the
 * *uncertainty* around the projection rather than bending the curve.
 */

export type PlayerTier = 'icon' | 'elite' | 'tournament_star' | 'host_nation' | 'breakout_rookie' | 'ordinary';

const ICONS = /\b(lionel messi|messi|cristiano ronaldo|ronaldo)\b/i;
const ELITE = /\b(mbappe|haaland|yamal|bellingham|vinicius|kane|neymar|de bruyne|salah|kylian)\b/i;
const HOST_NATIONS = new Set(['Mexico', 'USA', 'United States', 'Canada']);

export function classifyPlayer(player: string, team: string | null, subset: string, hot: boolean): PlayerTier {
  if (ICONS.test(player)) return 'icon';
  if (ELITE.test(player)) return 'elite';
  if (subset === 'RR' && hot) return 'breakout_rookie';
  if (team && HOST_NATIONS.has(team)) return 'host_nation';
  if (hot) return 'tournament_star';
  return 'ordinary';
}

/**
 * τ — how fast hype leaves, by who the player is. Priors, not measurements: they come
 * from previous tournament cycles, not from this one, and they are the first thing to
 * recalibrate once there are enough post-final observations to do it honestly.
 */
const DECAY: Record<PlayerTier, { halfLifeDays: number; hypeShare: number }> = {
  icon:             { halfLifeDays: 900, hypeShare: 0.03 },
  elite:            { halfLifeDays: 400, hypeShare: 0.15 },
  tournament_star:  { halfLifeDays: 150, hypeShare: 0.38 },
  host_nation:      { halfLifeDays: 110, hypeShare: 0.42 },
  breakout_rookie:  { halfLifeDays: 95,  hypeShare: 0.45 },
  ordinary:         { halfLifeDays: 200, hypeShare: 0.28 },
};

/**
 * How exposed a card's price is to event hype, as a multiplier on the player-tier
 * hype share. Scarcer printings carry proportionally less hype because more of their
 * price is scarcity a tournament cannot create or remove.
 *
 * These are priors too. What they are NOT is a claim about decay speed — τ above is
 * untouched by anything in this table, deliberately.
 */
const HYPE_EXPOSURE: Record<string, number> = {
  base: 1.00, parallel: 0.95, scarce: 0.90, scarcer: 0.84,
  ice: 0.74, foil: 0.62, elite: 0.52, unique: 0.44,
};

/** A graded card's buyer is a collector more often than a flipper. */
const GRADED_EXPOSURE = 0.90;

export interface TimingView {
  tier: PlayerTier;
  daysSinceFinal: number;
  /** modelled value in 30/90/180 days as a fraction of today */
  retain30: number;
  retain90: number;
  retain180: number;
  /** projected AUD loss from waiting 90 days */
  cost90Aud: number;
  halfLifeDays: number;
  /** 0..1 — how much the clock argues for selling now */
  urgency: number;
  note: string;
  /** The decomposition, exposed so the projection can be argued with. */
  model: {
    /** fraction of today's price attributed to the collector baseline, B/P */
    baselineShare: number;
    /** fraction attributed to event hype, H/P */
    hypeShare: number;
    /** the exposure multiplier scarcity contributed */
    rarityExposure: number;
    rarityTier: string;
    /** ± band on retain90, widened by scarcity and by thin trading */
    retain90Range: [number, number];
    uncertainty: number;
  };
}

export function timingView(args: {
  player: string; team: string | null; subset: string; hot: boolean;
  valueAud: number; trend30dPct?: number | null; now?: Date;
  /** Scarcity, for hype exposure — never for the decay rate. */
  printRun?: number | null; parallelName?: string | null; cardType?: string | null;
  grader?: string | null;
  /** Trading frequency, for the uncertainty band. Thin trading widens it. */
  salesPerMonth?: number | null;
}): TimingView {
  const now = args.now ?? new Date();
  const tier = classifyPlayer(args.player, args.team, args.subset, args.hot);
  const { halfLifeDays, hypeShare: tierHype } = DECAY[tier];
  const daysSinceFinal = Math.max(0, (now.getTime() - WC_FINAL.getTime()) / 86400_000);

  // Scarcity sets how much of the price is hype. It does NOT touch halfLifeDays.
  const rTier = rarityTier({
    print_run: args.printRun ?? null,
    parallel_name: args.parallelName ?? null,
    card_type: args.cardType ?? null,
  });
  let rarityExposure = HYPE_EXPOSURE[rTier] ?? 1;
  if (args.grader) rarityExposure *= GRADED_EXPOSURE;

  const hypeShare = Math.min(0.95, tierHype * rarityExposure);
  const retainedFloor = 1 - hypeShare;

  const retainAt = (extraDays: number) => {
    const t = daysSinceFinal + extraDays;
    const premiumNow = Math.pow(0.5, daysSinceFinal / halfLifeDays);
    const premiumThen = Math.pow(0.5, t / halfLifeDays);
    const valNow = retainedFloor + (1 - retainedFloor) * premiumNow;
    const valThen = retainedFloor + (1 - retainedFloor) * premiumThen;
    return valNow > 0 ? r3(valThen / valNow) : 1;
  };

  const retain30 = retainAt(30);
  const retain90 = retainAt(90);
  const retain180 = retainAt(180);
  const cost90Aud = r2(args.valueAud * (1 - retain90));

  // Urgency blends the model's projected decay with what the comps are already
  // doing. An observed 30-day downtrend is stronger evidence than any model.
  let urgency = Math.min(1, (1 - retain90) * 3.2);
  const obs = args.trend30dPct;
  if (obs != null) {
    if (obs < -8) urgency = Math.min(1, urgency + 0.25);
    else if (obs > 8) urgency = Math.max(0, urgency - 0.30);
  }
  if (tier === 'icon') urgency = Math.min(urgency, 0.15);

  const notes: Record<PlayerTier, string> = {
    icon: 'Icon demand was never tournament-contingent. No clock on this one — hold unless you need the cash.',
    elite: 'Elite name with a career ahead of it. Mild post-tournament drift; no need to rush, but the peak has passed.',
    tournament_star: 'Value came from the tournament, and the tournament is over. History says 20-40% back over the coming months.',
    host_nation: 'Host-nation premium is attention-driven and fades fastest. This is the window.',
    breakout_rookie: 'Breakout-rookie premium decays fastest of all — it is priced on hype, not track record. Move it while the glow lasts.',
    ordinary: 'No tournament premium to lose, but no catalyst either. Sell when convenient, not urgently.',
  };

  // Scarcity does not slow the decay — it widens the error bars, because a card that
  // trades once a quarter gives the model almost nothing to go on and a flat price
  // line is as likely to be missing data as it is to be stability.
  const thin = args.salesPerMonth != null
    ? Math.max(0, 1 - Math.min(1, args.salesPerMonth / 4))
    : 0.5;
  const uncertainty = r3(Math.min(0.85, 0.10 + 0.55 * (1 - rarityExposure) + 0.35 * thin));
  const band = (1 - retain90) * uncertainty;
  const retain90Range: [number, number] = [r3(Math.max(0, retain90 - band)), r3(Math.min(1.35, retain90 + band))];

  const sellBy = new Date(now.getTime() + Math.round(halfLifeDays * 0.5) * 86400_000);
  const note =
    `${notes[tier]} Modelled: ${(retain30 * 100).toFixed(0)}% of today's value in 30 days, ` +
    `${(retain90 * 100).toFixed(0)}% in 90 (about A$${cost90Aud.toFixed(2)} of decay), ` +
    `${(retain180 * 100).toFixed(0)}% in 180.` +
    ` Of today's price about ${(hypeShare * 100).toFixed(0)}% is modelled as event premium` +
    (rarityExposure < 0.99
      ? ` — reduced from ${(tierHype * 100).toFixed(0)}% because a ${rTier} printing carries` +
        ` proportionally less hype, not because it decays more slowly`
      : '') +
    `; the other ${(retainedFloor * 100).toFixed(0)}% is collector baseline.` +
    ` 90-day range ${(retain90Range[0] * 100).toFixed(0)}-${(retain90Range[1] * 100).toFixed(0)}%` +
    (thin > 0.5 ? ' (wide: this one trades thinly, so the projection is weakly evidenced)' : '') +
    '.' +
    (urgency > 0.5 ? ` Practical deadline: around ${sellBy.toISOString().slice(0, 10)}.` : '') +
    (obs != null ? ` Observed 30-day comp trend: ${obs > 0 ? '+' : ''}${obs.toFixed(1)}%.` : '');

  return { tier, daysSinceFinal: Math.round(daysSinceFinal), retain30, retain90, retain180,
           cost90Aud, halfLifeDays, urgency: r3(urgency), note,
           model: { baselineShare: r3(retainedFloor), hypeShare: r3(hypeShare),
                    rarityExposure: r3(rarityExposure), rarityTier: rTier,
                    retain90Range, uncertainty } };
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const r3 = (n: number) => Math.round(n * 1000) / 1000;
