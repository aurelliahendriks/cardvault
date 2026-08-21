-- CardVault :: card types, box provenance, custom cards, own photos
--
-- Three things the checklist alone couldn't answer:
--   "what kind of card is this?"      -> a real type taxonomy, derived not typed
--   "what box did it come out of?"    -> product_boxes + box_contents
--   "it's not on the checklist"       -> custom, user-created cards
-- Plus: your own photograph of your own copy outranks any harvested listing image.

-- ---------------------------------------------------------------------------
-- A home for cards that aren't in either licensed set
-- ---------------------------------------------------------------------------
INSERT INTO products (code, name, manufacturer, season, notes) VALUES
  ('X', 'Other / custom', NULL, NULL,
   'Cards you added yourself: other products, missing checklist entries, or anything else you own.')
ON CONFLICT (code) DO NOTHING;

ALTER TABLE cards
  ADD COLUMN IF NOT EXISTS is_custom  BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS set_name   TEXT,      -- free text for custom cards
  ADD COLUMN IF NOT EXISTS card_year  TEXT,
  ADD COLUMN IF NOT EXISTS notes      TEXT;

-- Custom cards are user data, not reference data: card_number need not be unique
-- within a section for them (you might own two different "unnumbered" promos).
ALTER TABLE cards DROP CONSTRAINT IF EXISTS cards_product_code_section_card_number_key;
CREATE UNIQUE INDEX IF NOT EXISTS cards_checklist_identity
  ON cards (product_code, section, card_number) WHERE NOT is_custom;

-- ---------------------------------------------------------------------------
-- Box / pack configurations
--
-- Sourced from product coverage where it exists, and flagged when it doesn't:
-- `verified` false means "reported but I could not corroborate it", which is a
-- different thing from a fact and should not be displayed as one.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS product_boxes (
  id              BIGSERIAL PRIMARY KEY,
  product_code    TEXT NOT NULL REFERENCES products(code) ON DELETE CASCADE,
  name            TEXT NOT NULL,               -- 'Hobby', 'Blaster', 'Fat Pack'
  channel         TEXT NOT NULL,               -- 'hobby' | 'retail' | 'international' | 'online'
  packs_per_box   INTEGER,
  cards_per_pack  INTEGER,
  cards_per_box   INTEGER,
  guaranteed      TEXT,                        -- '1 autograph + 1 memorabilia'
  contents_note   TEXT,
  msrp_aud        NUMERIC(10,2),
  verified        BOOLEAN NOT NULL DEFAULT FALSE,
  source_url      TEXT,
  sort_order      INTEGER DEFAULT 100,
  UNIQUE (product_code, name)
);

-- Which box a given section (optionally a specific parallel) comes out of.
CREATE TABLE IF NOT EXISTS box_contents (
  id              BIGSERIAL PRIMARY KEY,
  box_id          BIGINT NOT NULL REFERENCES product_boxes(id) ON DELETE CASCADE,
  section         TEXT,                        -- NULL = the whole product
  parallel_name   TEXT,                        -- NULL = any version of that section
  -- 'exclusive'          : only found here
  -- 'reported_exclusive' : claimed exclusive by a source I could not corroborate
  -- 'included'           : present, not exclusive
  availability    TEXT NOT NULL DEFAULT 'included',
  odds            TEXT,
  note            TEXT,
  UNIQUE (box_id, section, parallel_name)
);
CREATE INDEX IF NOT EXISTS box_contents_section ON box_contents (section);

-- ---------------------------------------------------------------------------
-- Holdings: where YOUR copy came from
-- ---------------------------------------------------------------------------
ALTER TABLE holdings
  ADD COLUMN IF NOT EXISTS box_id        BIGINT REFERENCES product_boxes(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS acquired_from TEXT,   -- 'pulled from a hobby box', 'eBay single', ...
  ADD COLUMN IF NOT EXISTS condition     TEXT;   -- your own note: 'NM', 'soft corner', ...

-- ---------------------------------------------------------------------------
-- Your own photographs
--
-- An uploaded photo of the card in your hand is better evidence than any
-- harvested listing image, so it takes priority and is never overwritten by the
-- harvester.
-- ---------------------------------------------------------------------------
ALTER TABLE skus
  ADD COLUMN IF NOT EXISTS image_path TEXT;      -- local file, set when image_source = 'upload'

-- ---------------------------------------------------------------------------
-- Views: type taxonomy + box provenance, derived in SQL so it can never drift
-- out of sync with the data
-- ---------------------------------------------------------------------------
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
       pa.name         AS parallel_name,
       pa.print_run,
       s.grader,
       s.grade,

       -- WHAT KIND OF CARD: the set-level category.
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

       -- WHICH VERSION of that card: the copy-level category.
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

       -- WHICH BOX: every configuration this section appears in, most specific
       -- claim first, so the UI can lead with an exclusivity if one exists.
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
            ELSE NULL END                                    AS image_source
FROM skus s
JOIN cards c    ON c.id = s.card_id
JOIN products p ON p.code = c.product_code
LEFT JOIN parallels pa ON pa.id = s.parallel_id;

CREATE VIEW portfolio AS
SELECT h.id            AS holding_id,
       h.sku_id,
       d.label,
       d.player, d.team, d.section, d.product_name, d.product_code, d.card_number,
       d.parallel_name, d.print_run, d.grader, d.grade, d.hot, d.subset,
       d.card_type, d.variant_type, d.is_rookie, d.is_custom, d.found_in,
       d.image_url, d.image_source,
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
