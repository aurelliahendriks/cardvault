import { q, one } from './db.js';
import { log } from './logger.js';

/**
 * Alert rules, evaluated against data already collected. Cheap, so it runs
 * hourly. Each rule is deliberately conservative about firing: an alert you
 * learn to ignore is worse than no alert.
 *
 * Every rule begins with "a card you hold", so every rule is per-person. Two consequences
 * once more than one person has an account, both of which were bugs before accounts existed
 * and are now avoidable:
 *
 *  - the row carries `user_id`, or the alert is delivered to everybody about somebody else's
 *    card;
 *  - the dedupe probe must include `user_id`, or the first person told their Mora moved
 *    silently suppresses the same alert for everyone else holding it.
 */

export interface AlertRule {
  type: 'price_drop' | 'price_spike' | 'new_comp' | 'sell_window' | 'thin_data';
  pct?: number;
  aud?: number;
}

export async function runAlerts(): Promise<{ fired: number }> {
  let fired = 0;

  // --- rule: a held card moved sharply ---------------------------------
  const moved = await q<{ sku_id: number; user_id: number; label: string; trend: number; value: number; n: number }>(
    `SELECT h.sku_id, h.user_id, d.label, v.trend_30d_pct AS trend, v.fair_value_aud AS value, v.n_comps AS n
       FROM holdings h
       JOIN sku_detail d ON d.sku_id = h.sku_id
       JOIN latest_valuation v ON v.sku_id = h.sku_id AND v.marketplace_code IS NULL
      WHERE h.qty > 0 AND v.n_comps >= 4 AND ABS(COALESCE(v.trend_30d_pct,0)) >= 15
        AND v.fair_value_aud * h.qty >= 40`,
  );
  for (const m of moved) {
    const down = m.trend < 0;
    const already = await one(
      `SELECT 1 FROM alerts WHERE sku_id = $1 AND user_id = $3
                              AND fired_at > now() - interval '5 days'
                              AND title LIKE $2`,
      [m.sku_id, down ? '%dropped%' : '%jumped%', m.user_id],
    );
    if (already) continue;
    await q(
      `INSERT INTO alerts (sku_id, user_id, severity, title, body, payload) VALUES ($1,$6,$2,$3,$4,$5)`,
      [m.sku_id, down ? 'warn' : 'info',
       `${m.label} ${down ? 'dropped' : 'jumped'} ${Math.abs(m.trend).toFixed(0)}% in 30 days`,
       down
         ? `Now A$${m.value.toFixed(2)} on ${m.n} comps. Post-tournament decay is the base case; if you were planning to sell this, waiting is costing you.`
         : `Now A$${m.value.toFixed(2)} on ${m.n} comps. A spike on thin volume often reverts — consider listing into the strength.`,
       JSON.stringify({ trend: m.trend, value: m.value, nComps: m.n }), m.user_id],
    );
    fired++;
  }

  // --- rule: a sell_now recommendation on something valuable -----------
  const urgent = await q<{ sku_id: number; user_id: number; label: string; net: number; action: string }>(
    `SELECT r.sku_id, h.user_id, d.label, r.best_net_aud AS net, r.action
       FROM latest_recommendation r
       JOIN holdings h ON h.sku_id = r.sku_id AND h.qty > 0
       JOIN sku_detail d ON d.sku_id = r.sku_id
      WHERE r.action = 'sell_now' AND r.best_net_aud >= 100 AND r.urgency >= 0.65`,
  );
  for (const u of urgent) {
    const already = await one(
      `SELECT 1 FROM alerts WHERE sku_id = $1 AND user_id = $2
                              AND fired_at > now() - interval '10 days' AND title LIKE 'Sell window%'`,
      [u.sku_id, u.user_id],
    );
    if (already) continue;
    await q(
      `INSERT INTO alerts (sku_id, user_id, severity, title, body, payload) VALUES ($1,$5,'warn',$2,$3,$4)`,
      [u.sku_id, `Sell window closing on ${u.label}`,
       `Modelled net A$${u.net.toFixed(2)}. The decay clock on this player tier is the reason for the urgency, not a price move.`,
       JSON.stringify({ net: u.net }), u.user_id],
    );
    fired++;
  }

  // --- rule: expensive holding with no real comps ----------------------
  const thin = await q<{ sku_id: number; user_id: number; label: string; value: number; method: string }>(
    `SELECT h.sku_id, h.user_id, d.label, COALESCE(v.fair_value_aud, d.seed_est_aud) AS value,
            COALESCE(v.method,'seed') AS method
       FROM holdings h
       JOIN sku_detail d ON d.sku_id = h.sku_id
       LEFT JOIN latest_valuation v ON v.sku_id = h.sku_id AND v.marketplace_code IS NULL
      WHERE h.qty > 0
        AND COALESCE(v.fair_value_aud, d.seed_est_aud, 0) >= 200
        AND COALESCE(v.n_comps, 0) = 0`,
  );
  for (const t of thin) {
    const already = await one(
      `SELECT 1 FROM alerts WHERE sku_id = $1 AND user_id = $2
                              AND fired_at > now() - interval '21 days' AND title LIKE 'No sold comps%'`,
      [t.sku_id, t.user_id],
    );
    if (already) continue;
    await q(
      `INSERT INTO alerts (sku_id, user_id, severity, title, body, payload) VALUES ($1,$5,'warn',$2,$3,$4)`,
      [t.sku_id, `No sold comps for ${t.label}`,
       `It is carried at A$${Number(t.value).toFixed(2)} from a "${t.method}" estimate, not an observed sale. That is a lot of value resting on a guess — check eBay sold listings manually, or add a comp via CSV import.`,
       JSON.stringify({ value: t.value, method: t.method }), t.user_id],
    );
    fired++;
  }

  if (fired) log.info({ fired }, 'alerts fired');
  return { fired };
}
