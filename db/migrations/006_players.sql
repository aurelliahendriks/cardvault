-- CardVault :: player portraits
--
-- Two different pictures answer two different questions:
--   the CARD photo  -> "is this the exact version I own?"   (harvested / uploaded)
--   the PLAYER photo -> "who is this?"                       (Wikidata / Commons)
--
-- The player photo is the useful fallback, because a card with no listing photo is
-- still instantly recognisable with the player's face on it. 1,771 cards resolve to
-- far fewer unique players, so this is a cheap lookup with a big effect.
--
-- Licensing is not optional. Wikimedia Commons images are overwhelmingly CC BY or
-- CC BY-SA, which REQUIRE attribution. Every row therefore stores the author,
-- licence and a link to the file page, and anything whose licence cannot be
-- established is refused rather than used. See docs/PORTRAITS.md.

CREATE TABLE IF NOT EXISTS players (
  id              BIGSERIAL PRIMARY KEY,
  name            TEXT NOT NULL UNIQUE,       -- matches cards.player exactly
  normalized      TEXT NOT NULL,              -- unaccented lowercase, for fuzzy joins
  -- identity
  wikidata_id     TEXT,                       -- 'Q...'
  wikidata_label  TEXT,
  -- imagery
  portrait_url    TEXT,                       -- Commons thumbnail URL
  portrait_full_url TEXT,                     -- original file URL
  portrait_path   TEXT,                       -- local cached copy
  portrait_mime   TEXT,
  portrait_width  INTEGER,
  -- attribution (all of this must be displayed wherever the portrait is)
  license         TEXT,
  license_url     TEXT,
  author          TEXT,
  credit_url      TEXT,                       -- the Commons file description page
  attribution_required BOOLEAN NOT NULL DEFAULT TRUE,
  -- bookkeeping
  lookup_status   TEXT NOT NULL DEFAULT 'pending',
     -- pending | ok | not_found | no_image | license_unclear | error | manual | skipped
  lookup_note     TEXT,
  attempts        INTEGER NOT NULL DEFAULT 0,
  fetched_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS players_normalized ON players (normalized);
CREATE INDEX IF NOT EXISTS players_pending ON players (lookup_status) WHERE lookup_status = 'pending';

-- Seed one row per distinct player already on the checklist.
INSERT INTO players (name, normalized)
SELECT DISTINCT c.player, unaccent(lower(c.player))
  FROM cards c
 WHERE c.player IS NOT NULL AND c.player <> ''
ON CONFLICT (name) DO NOTHING;

-- Expose the portrait alongside the card so the renderer needs one query.
DROP VIEW IF EXISTS portfolio;
DROP VIEW IF EXISTS sku_detail;

CREATE VIEW sku_detail AS
SELECT s.id            AS sku_id,
       s.label,
       c.id            AS card_id,
       c.legacy_id,
       c.product_code,
       COALESCE(c.set_name, p.name)                          AS product_name,
       c.is_custom,
       c.section,
       c.card_number,
       c.player,
       c.team,
       c.subset,
       c.hot,
       c.seed_est_aud,
       c.notes         AS card_notes,
       c.card_year,
       pa.name         AS parallel_name,
       pa.print_run,
       s.grader,
       s.grade,

       CASE
         WHEN c.section ILIKE '%dual autograph%'         THEN 'Dual Autograph'
         WHEN c.section ILIKE '%autograph%'
           OR c.section = 'Signature Series'             THEN 'Autograph'
         WHEN c.section ILIKE '%promotional%'            THEN 'Promo'
         WHEN c.section ILIKE 'base optic%'              THEN 'Base Optic'
         WHEN c.section ILIKE 'base%'                    THEN 'Base'
         WHEN c.is_custom AND c.section = 'Custom'       THEN 'Custom'
         ELSE 'Insert'
       END                                                   AS card_type,

       CASE
         WHEN s.grader IS NOT NULL AND pa.print_run = 1  THEN 'Graded 1/1'
         WHEN s.grader IS NOT NULL AND pa.id IS NOT NULL THEN 'Graded parallel'
         WHEN s.grader IS NOT NULL                       THEN 'Graded'
         WHEN pa.print_run = 1                           THEN 'One of one'
         WHEN pa.print_run IS NOT NULL                   THEN 'Numbered /' || pa.print_run
         WHEN pa.id IS NOT NULL                          THEN 'Parallel'
         ELSE 'Raw base'
       END                                                   AS variant_type,

       (c.subset = 'RR' OR c.is_rookie)                      AS is_rookie,

       (SELECT json_agg(json_build_object(
                 'box', b.name, 'channel', b.channel,
                 'availability', bc.availability, 'odds', bc.odds,
                 'verified', b.verified, 'note', bc.note)
               ORDER BY CASE bc.availability
                          WHEN 'exclusive' THEN 0
                          WHEN 'reported_exclusive' THEN 1
                          ELSE 2 END, b.sort_order)
          FROM box_contents bc
          JOIN product_boxes b ON b.id = bc.box_id
         WHERE b.product_code = c.product_code
           AND (bc.section IS NULL OR bc.section = c.section)
           AND (bc.parallel_name IS NULL OR bc.parallel_name = pa.name)) AS found_in,

       COALESCE(s.image_url, c.image_url)                    AS image_url,
       s.image_path,
       CASE WHEN s.image_path IS NOT NULL THEN 'upload'
            WHEN s.image_url IS NOT NULL  THEN s.image_source
            WHEN c.image_url IS NOT NULL  THEN 'inherited'
            ELSE NULL END                                    AS image_source,

       -- player portrait + the attribution that must travel with it
       pl.portrait_path                                      AS portrait_path,
       pl.portrait_url                                       AS portrait_url,
       pl.license                                            AS portrait_license,
       pl.license_url                                        AS portrait_license_url,
       pl.author                                             AS portrait_author,
       pl.credit_url                                         AS portrait_credit_url,
       pl.lookup_status                                      AS portrait_status
FROM skus s
JOIN cards c    ON c.id = s.card_id
JOIN products p ON p.code = c.product_code
LEFT JOIN parallels pa ON pa.id = s.parallel_id
LEFT JOIN players   pl ON pl.name = c.player;

CREATE VIEW portfolio AS
SELECT h.id            AS holding_id,
       h.sku_id,
       d.label,
       d.player, d.team, d.section, d.product_name, d.product_code, d.card_number,
       d.parallel_name, d.print_run, d.grader, d.grade, d.hot, d.subset,
       d.card_type, d.variant_type, d.is_rookie, d.is_custom, d.found_in,
       d.image_url, d.image_source, d.portrait_status,
       h.qty,
       h.cost_basis_aud,
       h.acquired_from,
       h.condition,
       b.name          AS box_name,
       b.channel       AS box_channel,
       COALESCE(h.price_override_aud, v.fair_value_aud, d.seed_est_aud) AS unit_value_aud,
       COALESCE(h.price_override_aud, v.fair_value_aud, d.seed_est_aud) * h.qty AS total_value_aud,
       v.n_comps, v.trend_30d_pct, v.confidence, v.method, v.as_of AS priced_at,
       r.action, r.best_marketplace_code, r.best_net_aud, r.score, r.urgency
FROM holdings h
JOIN sku_detail d ON d.sku_id = h.sku_id
LEFT JOIN product_boxes b ON b.id = h.box_id
LEFT JOIN latest_valuation v ON v.sku_id = h.sku_id AND v.marketplace_code IS NULL
LEFT JOIN latest_recommendation r ON r.sku_id = h.sku_id;
