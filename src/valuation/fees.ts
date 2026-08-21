import { q } from '../db.js';
import { convert, round2, toAud } from './fx.js';

export interface MarketplaceEcon {
  code: string;
  name: string;
  region: string;
  currency: string;
  fee_pct: number;
  fee_fixed: number;
  fee_fixed_ccy: string | null;
  intl_fee_pct: number;
  payment_fee_pct: number;
  ad_rate_typical: number;
  ship_from_au_cost: number | null;
  ship_days_est: number | null;
  customs_risk: number;
  requires_local_entity: boolean;
  price_realization: number;
  min_value_aud: number;
  max_value_aud: number | null;
  audience_note: string | null;
}

export interface NetProceeds {
  marketplaceCode: string;
  /** what the card is expected to sell for on this marketplace, in AUD */
  grossAud: number;
  feesAud: number;
  shippingAud: number;
  /** expected drag from buyer-side duty/tariff suppressing the winning bid */
  frictionAud: number;
  netAud: number;
  /** net as a fraction of gross — the honest "how much do I keep" number */
  keepRate: number;
  shipDays: number | null;
  requiresLocalEntity: boolean;
  notes: string[];
}

export async function marketplaceEcon(codes?: string[]): Promise<MarketplaceEcon[]> {
  if (codes?.length) {
    return q<MarketplaceEcon>(
      `SELECT * FROM marketplaces WHERE active AND code = ANY($1::text[])`, [codes],
    );
  }
  return q<MarketplaceEcon>(`SELECT * FROM marketplaces WHERE active ORDER BY code`);
}

/**
 * Net proceeds for selling one card on one marketplace, in AUD.
 *
 * The reason this exists rather than "just compare prices": a card that fetches
 * A$100 on eBay US and A$92 on eBay AU is NOT better sold in the US. Once you
 * add the 1.65% international fee, A$18 tracked postage instead of A$9, and the
 * tariff drag on what US buyers will bid, the AU sale usually wins. This
 * function is the only place that comparison is allowed to happen.
 *
 * @param grossAud expected sale price on that marketplace, already in AUD
 * @param opts.useAds whether to model the promoted-listing rate you'd realistically run
 */
export async function netProceeds(
  m: MarketplaceEcon,
  grossAud: number,
  opts: { useAds?: boolean; sellerIsOffshore?: boolean; shippingChargedAud?: number } = {},
): Promise<NetProceeds> {
  const notes: string[] = [];
  const shippingCost = m.ship_from_au_cost ?? 0;
  const shippingCharged = opts.shippingChargedAud ?? 0;

  // eBay charges the final value fee on item + shipping + tax. Model the common
  // case: free postage baked into the price, so the fee base is the gross.
  const feeBase = grossAud + shippingCharged;

  let feePct = Number(m.fee_pct);
  // The international-transaction surcharge applies when buyer and seller are in
  // different eBay regions — which, selling from Australia into eBay US, is always.
  const offshore = opts.sellerIsOffshore ?? m.region !== 'AU';
  if (offshore && m.intl_fee_pct > 0) {
    feePct += Number(m.intl_fee_pct);
    notes.push(`+${(Number(m.intl_fee_pct) * 100).toFixed(2)}% international transaction fee (AU seller, ${m.region} site)`);
  }
  if (opts.useAds && m.ad_rate_typical > 0) {
    feePct += Number(m.ad_rate_typical);
    notes.push(`+${(Number(m.ad_rate_typical) * 100).toFixed(1)}% promoted listings`);
  }
  feePct += Number(m.payment_fee_pct);

  const fixedAud = m.fee_fixed
    ? await convert(Number(m.fee_fixed), m.fee_fixed_ccy ?? m.currency, 'AUD')
    : 0;

  const feesAud = round2(feeBase * feePct + fixedAud);

  // Customs/tariff friction is a demand-side haircut, not a fee you pay: buyers
  // facing import duty bid less. Modelled as a fraction of gross.
  const frictionAud = round2(grossAud * Number(m.customs_risk) * 0.35);
  if (frictionAud > 0) {
    notes.push(`~A$${frictionAud.toFixed(2)} expected bid suppression from ${m.region} import duty/tariffs on declared card value`);
  }

  if (m.requires_local_entity) {
    notes.push('Needs a local address/bank or a proxy service — treat the net figure as best-case');
  }

  const netAud = round2(grossAud + shippingCharged - feesAud - shippingCost - frictionAud);

  return {
    marketplaceCode: m.code,
    grossAud: round2(grossAud),
    feesAud,
    shippingAud: round2(shippingCost),
    frictionAud,
    netAud,
    keepRate: grossAud > 0 ? Math.round((netAud / grossAud) * 1000) / 1000 : 0,
    shipDays: m.ship_days_est,
    requiresLocalEntity: m.requires_local_entity,
    notes,
  };
}

/**
 * Break-even: the lowest gross price at which a sale on this marketplace beats
 * not bothering. Below this, postage plus fees eat the card.
 */
export async function breakEvenAud(m: MarketplaceEcon, minProfitAud = 2): Promise<number> {
  const ship = m.ship_from_au_cost ?? 0;
  const fixed = m.fee_fixed ? await convert(Number(m.fee_fixed), m.fee_fixed_ccy ?? m.currency, 'AUD') : 0;
  let pct = Number(m.fee_pct) + Number(m.payment_fee_pct);
  if (m.region !== 'AU') pct += Number(m.intl_fee_pct);
  const denom = 1 - pct - Number(m.customs_risk) * 0.35;
  if (denom <= 0) return Infinity;
  return round2((ship + fixed + minProfitAud) / denom);
}
