import { q, one } from '../db.js';
import { fxTrend30d } from '../valuation/fx.js';
import { marketplaceEcon, netProceeds, breakEvenAud, type MarketplaceEcon } from '../valuation/fees.js';

/**
 * Where to sell, ranked by net proceeds in AUD.
 *
 * The important subtlety: the expected gross price is NOT the same on every
 * marketplace. Rather than assume one global price, we use each marketplace's
 * own comps where they exist, and fall back to the global figure adjusted by a
 * regional demand factor when they don't. That factor is what encodes things
 * like "Mexico squad cards clear above global on MercadoLibre MX" and "Spain
 * squad over-indexes on eBay ES".
 */

export interface VenueRank {
  marketplaceCode: string;
  name: string;
  region: string;
  expectedGrossAud: number;
  netAud: number;
  keepRate: number;
  shipDays: number | null;
  /** where the gross figure came from */
  grossBasis: 'own_comps' | 'regional_adjusted';
  nComps: number;
  belowBreakEven: boolean;
  requiresLocalEntity: boolean;
  fxTrend30d: number | null;
  /** set when the card's value sits outside this venue's sensible band */
  outOfBand: 'below' | 'above' | null;
  notes: string[];
}

/**
 * Regional demand multipliers vs the global blended price.
 *
 * These are priors, applied only when a marketplace has no comps of its own.
 * As real comps accumulate per marketplace they take over completely, which is
 * the point — the priors exist to make a cold start useful, not to be believed
 * forever.
 */
function regionalFactor(region: string, team: string | null, player: string, section: string): { f: number; why: string[] } {
  const why: string[] = [];
  let f = 1;

  const nat = (t: string) => team != null && team.toLowerCase() === t.toLowerCase();

  switch (region) {
    case 'AU':
      f = 0.92; why.push('Thinnest soccer bidder pool of the major markets; expect ~8% under global.');
      if (nat('Australia')) { f = 1.10; why.push('Socceroos cards over-index at home.'); }
      break;
    case 'US':
      f = 1.06; why.push('Deepest sports-card money; premium on high-end.');
      if (/kaboom|signature|autograph|beautiful game/i.test(section)) { f = 1.14; why.push('US pool sets the market on Kabooms and autos.'); }
      if (nat('USA') || nat('United States')) { f += 0.08; why.push('Home-nation demand.'); }
      break;
    case 'UK':
      f = 1.02; why.push('Strong football culture, mid-tier depth.');
      if (nat('England') || nat('Cymru') || nat('Wales') || nat('Scotland')) { f = 1.16; why.push('Home-nation premium on eBay UK.'); }
      break;
    case 'DE':
      f = 1.00; why.push('Panini is the native European brand; healthy mid-tier.');
      if (nat('Germany')) { f = 1.18; why.push('Germany squad premium.'); }
      break;
    case 'ES':
      f = 0.98;
      if (nat('Spain')) { f = 1.20; why.push('Spain squad and La Liga names over-index heavily here (Yamal in particular).'); }
      if (/yamal/i.test(player)) { f = Math.max(f, 1.22); why.push('Yamal is a domestic-hero card in Spain.'); }
      break;
    case 'MX':
      f = 0.85; why.push('Generally below global for non-Mexico cards.');
      if (nat('Mexico')) { f = 1.28; why.push('Host-nation demand engine for 2026 — Mexico squad clears well above global here.'); }
      if (/mora/i.test(player)) { f = Math.max(f, 1.35); why.push('Gilberto Mora is the single hottest host-nation rookie; Mexican demand is where his premium lives.'); }
      break;
    case 'JP':
      f = 0.80; why.push('Thin for soccer.');
      if (nat('Japan')) { f = 1.15; why.push('Japan squad demand.'); }
      if (/psa|bgs/i.test(section)) { f += 0.05; }
      break;
    case 'AR':
      f = 0.90;
      if (nat('Argentina')) { f = 1.15; why.push('Argentina demand is intense but settlement is the problem, not price.'); }
      break;
    case 'SG':
      f = 0.82; why.push('Growing SEA scene but a low ceiling.');
      break;
    default:
      f = 0.95;
  }
  return { f: Math.round(f * 1000) / 1000, why };
}

export async function rankVenues(args: {
  skuId: number;
  globalValueAud: number;
  team: string | null;
  player: string;
  section: string;
  useAds?: boolean;
}): Promise<VenueRank[]> {
  const markets = await marketplaceEcon();

  // per-marketplace comp-backed prices
  const own = await q<{ marketplace_code: string; fair_value_aud: number; n_comps: number }>(
    `SELECT marketplace_code, fair_value_aud, n_comps FROM latest_valuation
      WHERE sku_id = $1 AND marketplace_code IS NOT NULL AND n_comps >= 2`,
    [args.skuId],
  );
  const ownMap = new Map(own.map((o) => [o.marketplace_code, o]));

  const out: VenueRank[] = [];

  for (const m of markets) {
    const o = ownMap.get(m.code);
    let gross: number;
    let basis: VenueRank['grossBasis'];
    let nComps = 0;
    const notes: string[] = [];

    if (o && o.fair_value_aud > 0) {
      // Real sales on this venue already embody its price realization — don't
      // apply the multiplier a second time.
      gross = Number(o.fair_value_aud);
      basis = 'own_comps';
      nComps = o.n_comps;
      notes.push(`Priced off ${nComps} sale${nComps === 1 ? '' : 's'} on ${m.code} itself.`);
    } else {
      const { f, why } = regionalFactor(m.region, args.team, args.player, args.section);
      const realization = Number(m.price_realization ?? 1);
      gross = Math.round(args.globalValueAud * f * realization * 100) / 100;
      basis = 'regional_adjusted';
      notes.push(
        `No ${m.code} sales yet — global A$${args.globalValueAud.toFixed(2)} adjusted by ${f}x regional demand` +
        (realization !== 1 ? ` and ${(realization * 100).toFixed(0)}% price realization` : '') + '.',
        ...why,
      );
      if (realization < 0.8) {
        notes.push(`This venue is fast and fee-free precisely because it pays under market — expect roughly ${(realization * 100).toFixed(0)}c in the dollar.`);
      }
      if (realization > 1) {
        notes.push(`Their bidder pool can beat open-market price on the right card, which is what the ~${(Number(m.fee_pct) * 100).toFixed(0)}% seller cost buys you.`);
      }
    }

    // Value band: a venue can be wrong for a card regardless of arithmetic.
    const minV = Number(m.min_value_aud ?? 0);
    const maxV = m.max_value_aud == null ? null : Number(m.max_value_aud);
    const outOfBand =
      args.globalValueAud < minV ? 'below' :
      maxV != null && args.globalValueAud > maxV ? 'above' : null;
    if (outOfBand === 'below') {
      notes.push(`Below this venue's practical floor of A$${minV.toFixed(0)} — the effort per card exceeds the return.`);
    } else if (outOfBand === 'above') {
      notes.push(`Above A$${maxV!.toFixed(0)}: buyers at this level want escrow and a track record, which this venue does not provide. Treat the figure as optimistic.`);
    }

    const np = await netProceeds(m, gross, { useAds: args.useAds });
    const be = await breakEvenAud(m);
    const trend = await fxTrend30d(m.currency);
    if (trend != null && Math.abs(trend) >= 3 && m.currency !== 'AUD') {
      notes.push(`${m.currency} is ${trend > 0 ? 'up' : 'down'} ${Math.abs(trend).toFixed(1)}% vs AUD over 30 days — ${trend > 0 ? 'a tailwind for selling offshore right now' : 'an FX headwind on offshore sales'}.`);
    }
    if (m.audience_note) notes.push(m.audience_note);

    out.push({
      marketplaceCode: m.code,
      name: m.name,
      region: m.region,
      expectedGrossAud: gross,
      netAud: np.netAud,
      keepRate: np.keepRate,
      shipDays: np.shipDays,
      grossBasis: basis,
      nComps,
      belowBreakEven: gross < be,
      requiresLocalEntity: np.requiresLocalEntity,
      fxTrend30d: trend,
      outOfBand,
      notes: [...notes, ...np.notes],
    });
  }

  // Rank by net, but discount venues you realistically can't or shouldn't use
  // rather than hiding them — you should still see what you're leaving behind
  // and why.
  return out.sort((a, b) => rankKey(b) - rankKey(a));
}

function rankKey(v: VenueRank): number {
  let k = v.netAud;
  if (v.requiresLocalEntity) k *= 0.75;   // needs a proxy service to actually collect
  if (v.belowBreakEven) k *= 0.4;
  if (v.outOfBand) k *= 0.6;              // arithmetic says yes, reality says no
  return k;
}
