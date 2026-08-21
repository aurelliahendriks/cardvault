-- CardVault :: where a card sells, geographically
--
-- Three additions, and one honest limit stated up front.
--
-- The limit: there is no accessible source of SUBURB-level sold-price data. eBay returns
-- an item location — usually a city and a state, sometimes only a country — and that is
-- the finest grain anything real can support. A Melbourne-suburb heat map would be
-- invented precision, so this stores exactly what the source gives and no more.
--
-- 1. `listings.seller_city` / `seller_region`: eBay's Browse API returns
--    itemLocation.city and .stateOrProvince alongside .country, and only the country was
--    being kept. Storing the other two is what makes any geographic view possible at all.
-- 2. `regional_demand`: a view over comps by marketplace region, so "is this hot in
--    Europe" is answered from sold prices rather than from a prior.
-- 3. Melbourne local channels seeded into `communities`, because the local layer exists
--    in no API and has to be hand-entered to exist at all.

ALTER TABLE listings ADD COLUMN IF NOT EXISTS seller_city   TEXT;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS seller_region TEXT;

CREATE INDEX IF NOT EXISTS listings_geo_idx
  ON listings (seller_country, seller_region)
  WHERE seller_country IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Regional demand, measured
-- ---------------------------------------------------------------------------
--
-- Deliberately per MARKETPLACE region, not per seller location: the question "where does
-- this sell well" is about which market you list into, and a Melbourne seller shipping to
-- a German buyer is a data point about Germany's demand, not Victoria's.
--
-- `n_comps` is exposed so the UI can refuse to draw a conclusion from one sale. Every
-- consumer of this view has to show it.
CREATE OR REPLACE VIEW regional_demand AS
SELECT c.sku_id,
       m.region,
       c.marketplace_code,
       m.name                                        AS marketplace,
       m.currency,
       COUNT(*)::int                                 AS n_comps,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY c.price_aud) AS median_aud,
       MIN(c.price_aud)                              AS low_aud,
       MAX(c.price_aud)                              AS high_aud,
       MAX(c.sold_at)                                AS last_sold_at,
       -- Net of this venue's headline fee and its price realization, so regions are
       -- compared on what you would actually keep.
       percentile_cont(0.5) WITHIN GROUP (ORDER BY c.price_aud)
         * (1 - m.fee_pct - m.intl_fee_pct) * m.price_realization AS net_median_aud
  FROM comps c
  JOIN marketplaces m ON m.code = c.marketplace_code
 WHERE NOT c.excluded
 GROUP BY c.sku_id, m.region, c.marketplace_code, m.name, m.currency, m.fee_pct,
          m.intl_fee_pct, m.price_realization;

COMMENT ON VIEW regional_demand IS
  'Sold-price demand by marketplace region. n_comps must be shown wherever median_aud is: '
  'a single sale is a data point, not a market.';

-- ---------------------------------------------------------------------------
-- Melbourne, properly
-- ---------------------------------------------------------------------------
--
-- Local channels are where a A$20-A$300 card actually moves without postage eating the
-- margin, and none of it is in any API. Realization figures are the honest part: a shop
-- pays 40-60% of market because it is instant and carries the risk, a meet is close to
-- full market but slow and depends on who turns up.
--
-- `notes` carries the caveat in every row. Anything here may be out of date — shops close,
-- meets move — so treat it as a starting list to correct, not a directory.

INSERT INTO communities
  (name, kind, region, url, fee_pct, audience_size, focus_sections, focus_teams,
   min_value_aud, max_value_aud, likes_lots, likes_graded, speed_score, price_realization, notes)
VALUES
  ('Melbourne card shops (walk-in cash offer)', 'local_shop', 'AU-VIC', NULL,
   0, NULL, '{}', '{}', 20, 4000, TRUE, TRUE, 0.95, 0.55,
   'Instant and fee-free, and they pay 40-60% of market for exactly that reason. Best for '
   || 'bulk and mid-value cards you want gone today. Ring first; stock appetite varies weekly.'),

  ('Melbourne / VIC card meets and shows', 'meet', 'AU-VIC', NULL,
   0, NULL, '{}', '{}', 30, 8000, TRUE, TRUE, 0.45, 0.88,
   'Close to full market with no fees and no postage, but you only reach whoever attends. '
   || 'Bring a price list. Slow for anything niche.'),

  ('Melbourne Facebook buy/swap/sell groups', 'facebook_group', 'AU-VIC', NULL,
   0, NULL, '{}', '{}', 15, 1500, TRUE, FALSE, 0.6, 0.9,
   'No selling fees and local pickup avoids postage entirely. Payment risk is on you: '
   || 'PayID or cash on pickup, never a promise. Groups have no sold-price history, so '
   || 'record what you achieve as a manual comp or the data is lost.'),

  ('Gumtree Victoria (local pickup)', 'classified', 'AU-VIC', 'https://www.gumtree.com.au',
   0, NULL, '{}', '{}', 25, 2000, TRUE, FALSE, 0.35, 0.82,
   'Slow and full of lowball offers, but genuinely free and local. Worth it for bulk lots '
   || 'that are not worth posting.'),

  ('Australian football-card Facebook groups (national)', 'facebook_group', 'AU', NULL,
   0, NULL, '{}', '{}', 20, 6000, TRUE, TRUE, 0.55, 0.92,
   'Bigger audience than the Melbourne groups and still fee-free, but you post the card, '
   || 'so factor A$9-13 and the risk of a lost parcel.')
ON CONFLICT DO NOTHING;
