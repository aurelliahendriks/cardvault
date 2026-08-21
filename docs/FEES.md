# Fees, marketplaces and how to correct them

Everything in this file is stored in the `marketplaces` and `communities` tables, not
in code, so you can fix it with SQL and no redeploy. **Do that before trusting the
"where to sell" output on an expensive card.** Fee schedules change; these were
current as of July 2026 and only the eBay trading-card numbers were verified directly.

## Verified

eBay final value fee for Sports / Non-Sport / CCG trading cards, non-store sellers:

- **13.25%** up to $7,500, then 2.35% on the portion above
- **$0.30** per order at or under $10, **$0.40** above
- charged on item price + shipping + tax

Source: [tcgfeecalc.com/ebay](https://tcgfeecalc.com/ebay) (July 2026), consistent
with the widely reported 13.6%-including-fixed-fee figures in
[Taxomate's 2026 breakdown](https://taxomate.com/blog/ebay-seller-fees).

## Best-effort — confirm before relying on

| Venue | fee_pct | price_realization | Why the realization value |
|---|---|---|---|
| eBay AU/US/UK/DE/ES/JP | 0.11–0.1325 | 1.00 | eBay *is* the reference market |
| Mercari JP | 0.10 | 0.95 | cheap, but needs a JP address/bank or a proxy |
| Yahoo! Auctions JP | 0.10 | 0.98 | where Japanese collectors actually bid |
| MercadoLibre MX | 0.16 + 4% payment | 1.00 | high fees, but genuine host-nation demand |
| Whatnot | 0.08 + 2.9% | 0.87 | live auctions clear at ~80–90% of eBay |
| Facebook groups (AU) | 0.00 | 0.87 | fee-free, but realizes ~85–90% |
| Local card shop / show | 0.00 | **0.50** | shops buy at 40–60% of market |
| PWCC / Fanatics Collect | 0.20 | 1.15 | their bidder pool sets records above ~A$1,500 |
| Goldin | 0.20 | 1.20 | top end only, A$5k+ |

`price_realization` exists because fees alone rank venues backwards. A zero-fee
channel looks like a 100%-keep sale; the reason it's fee-free and instant is that it
pays under market. Without this column a A$24,000 PSA 10 Messi Kaboom gets routed to
a local card shop.

The **international transaction fee (1.65%)** applies to every offshore sale from an
Australian seller. It's small but it compounds with postage and tariff drag, and
together those three are usually what decide AU-vs-US.

`customs_risk` (0–1) is **not** a fee you pay. It models buyer-side import duty
suppressing bids, applied as `gross × customs_risk × 0.35`. The US value is high
because of tariffs on declared card value, which is also why direct-from-Australia
PSA submission became awkward.

## Grading costs (Australia)

| Tier | All-in AUD | Realistic turnaround |
|---|---|---|
| PSA Value Bulk (20+ via AU middleman) | ~62 | ~7 months |
| PSA Value (via AU middleman) | ~68 | ~6 months |
| PSA Value Max | ~195 | ~2 months |
| PSA Regular | ~215 | ~6 weeks |
| PSA Express | ~315 | ~1 month |

Middleman list prices (Slabbys PSA Value Bulk A$48/card, Value A$50/card) *include*
grading plus shipping **to** PSA. Return postage and upcharges are extra, so all-in
lands at A$55–70 at the cheapest tiers. Add 1–3 months of consolidation and transit
on top of PSA's stated turnaround.

Gem rates in `recommend/grading.ts` are deliberately conservative:

| Section | Assumed PSA 10 rate |
|---|---|
| Kaboom! | 22% |
| Animation / Zero Gravity / Night Moves | 30% |
| autographs | 34% |
| Optic / Prizm | 42% |
| base | 45–48% |

Full-bleed inserts get capped at 9 by centering and print lines far more often than
people expect, and a PSA 9 often sells at or below 2× raw — which does not cover the
fee. Do not assume a 10.

## Correcting values

```sql
-- fee change
UPDATE marketplaces SET fee_pct = 0.1400 WHERE code = 'EBAY_AU';

-- your actual postage, not the estimate
UPDATE marketplaces SET ship_from_au_cost = 11.50 WHERE code = 'EBAY_AU';

-- you learned the local shop pays better than modelled
UPDATE marketplaces SET price_realization = 0.62 WHERE code = 'LOCAL_LCS';

-- a community turned out to be a better channel than seeded
UPDATE communities SET price_realization = 1.10, speed_score = 0.85
 WHERE name = 'Tarjetas y Estampas Mexico (FB)';

-- stop suggesting a venue entirely
UPDATE marketplaces SET active = FALSE WHERE code = 'ML_AR';
```

Then `npm run recommend` to re-rank.

## Calibrating from your own sales

The `sales` table is the feedback loop. After a dozen real sales, compare what you
actually netted against what the model predicted:

```sql
SELECT m.name,
       COUNT(*)                                   AS sales,
       ROUND(AVG(s.net_aud / NULLIF(v.fair_value_aud * s.qty, 0)), 3) AS actual_keep_vs_fair,
       ROUND(AVG(r.best_net_aud / NULLIF(s.net_aud, 0)), 3)          AS predicted_over_actual
  FROM sales s
  JOIN marketplaces m ON m.code = s.marketplace_code
  LEFT JOIN latest_valuation v ON v.sku_id = s.sku_id AND v.marketplace_code IS NULL
  LEFT JOIN latest_recommendation r ON r.sku_id = s.sku_id
 GROUP BY m.name
 HAVING COUNT(*) >= 3
 ORDER BY sales DESC;
```

If `predicted_over_actual` sits consistently above 1 for a venue, its
`price_realization` is too generous. Lower it. That query is the single most valuable
thing in this file once you have real sales history — your own data beats every prior
seeded here.
