-- CardVault :: card imagery
--
-- No external image source is needed: every matched eBay listing already carries
-- a photo of the exact card, so the app harvests its own artwork from the comps
-- it collects. The best image for a SKU is the one attached to its
-- highest-confidence recent sale.
--
-- Images live on `skus`, not `cards`, because a Blue /49 parallel and a PSA 10
-- slab do not look like the raw base card — showing the base photo for a graded
-- card is actively misleading when the whole point is visual identification.

ALTER TABLE skus
  ADD COLUMN IF NOT EXISTS image_url        TEXT,
  ADD COLUMN IF NOT EXISTS image_source     TEXT,      -- 'listing' | 'manual' | 'inherited'
  ADD COLUMN IF NOT EXISTS image_listing_id BIGINT REFERENCES listings(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS image_updated_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS skus_missing_image ON skus (id) WHERE image_url IS NULL;

-- Card-level image is the fallback shown for versions with no photo of their own.
ALTER TABLE cards
  ADD COLUMN IF NOT EXISTS image_url        TEXT,
  ADD COLUMN IF NOT EXISTS image_updated_at TIMESTAMPTZ;

-- Recreate sku_detail to expose imagery to the gallery, with the inheritance
-- chain resolved in SQL so the UI never has to make a second request to find out
-- which photo to show.
DROP VIEW IF EXISTS portfolio;
DROP VIEW IF EXISTS sku_detail;

CREATE VIEW sku_detail AS
SELECT s.id            AS sku_id,
       s.label,
       c.id            AS card_id,
       c.legacy_id,
       c.product_code,
       p.name          AS product_name,
       c.section,
       c.card_number,
       c.player,
       c.team,
       c.subset,
       c.hot,
       c.seed_est_aud,
       pa.name         AS parallel_name,
       pa.print_run,
       s.grader,
       s.grade,
       COALESCE(s.image_url, c.image_url)                    AS image_url,
       CASE WHEN s.image_url IS NOT NULL THEN s.image_source
            WHEN c.image_url IS NOT NULL THEN 'inherited'
            ELSE NULL END                                    AS image_source
FROM skus s
JOIN cards c   ON c.id = s.card_id
JOIN products p ON p.code = c.product_code
LEFT JOIN parallels pa ON pa.id = s.parallel_id;

CREATE VIEW portfolio AS
SELECT h.id            AS holding_id,
       h.sku_id,
       d.label,
       d.player, d.team, d.section, d.product_name, d.product_code, d.card_number,
       d.parallel_name, d.print_run, d.grader, d.grade, d.hot, d.subset,
       d.image_url, d.image_source,
       h.qty,
       h.cost_basis_aud,
       COALESCE(h.price_override_aud, v.fair_value_aud, d.seed_est_aud) AS unit_value_aud,
       COALESCE(h.price_override_aud, v.fair_value_aud, d.seed_est_aud) * h.qty AS total_value_aud,
       v.n_comps, v.trend_30d_pct, v.confidence, v.method, v.as_of AS priced_at,
       r.action, r.best_marketplace_code, r.best_net_aud, r.score, r.urgency
FROM holdings h
JOIN sku_detail d ON d.sku_id = h.sku_id
LEFT JOIN latest_valuation v ON v.sku_id = h.sku_id AND v.marketplace_code IS NULL
LEFT JOIN latest_recommendation r ON r.sku_id = h.sku_id;
