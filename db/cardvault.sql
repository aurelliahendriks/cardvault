-- ===========================================================================
--  CardVault :: the whole database, in one file
-- ===========================================================================
--
--  Every migration in db/migrations/, in order, in one file. It exists because "run fifteen
--  files in the right sequence" is a worse instruction than "run this one".
--
--  ---------------------------------------------------------------------------
--  WHAT IT DOES NOT CONTAIN: THE CARDS
--  ---------------------------------------------------------------------------
--
--  The 2,521-card checklist lives in db/seeds/cards.json and loads separately, with
--  `npm run seed`. That split is deliberate:
--
--     this file    the SHAPE of the database - tables, views, constraints, and the parallel
--                  ladders for all five sets. Changes when the app changes.
--     cards.json   the CONTENTS - player names and card numbers off published checklists.
--                  Changes when a new set comes out.
--
--  So re-seeding the checklist cannot drop your collection, and changing the schema cannot
--  lose the checklist.
--
--  ---------------------------------------------------------------------------
--  RUNNING IT
--  ---------------------------------------------------------------------------
--
--     docker compose up migrate           <- the normal way: this file AND the seed
--
--  or by hand against a running database:
--
--     docker compose exec -T db psql -U cardvault -d cardvault < db/cardvault.sql
--     docker compose exec api npx tsx src/cli/seed.ts
--
--  ---------------------------------------------------------------------------
--  RUNNING IT TWICE IS SAFE, AND THAT IS TESTED
--  ---------------------------------------------------------------------------
--
--  Wrapped in one transaction, so a failure half way leaves nothing behind rather than a
--  half-built database that looks fine until something reads the missing half.
--
--  Every statement is IF NOT EXISTS, OR REPLACE, dropped-then-recreated, or ON CONFLICT DO
--  UPDATE. Verified by `node tools/build-sql.mjs --verify`, which applies the file twice and
--  checks that the SECOND run also succeeded - an earlier version of this bundle silently
--  rolled its second run back, and a naive schema diff called that a pass.
--
--  One honest limit of IF NOT EXISTS: it checks the NAME, not the shape. A table that already
--  exists with different columns is left alone, silently. That is fine for bringing a
--  database up to date, and it is why the tracked runner (src/cli/migrate.ts) stays the tool
--  for anything more interesting.
--
--  GENERATED FROM db/migrations/. Edit the migrations, not this file.
-- ===========================================================================

BEGIN;

-- ###########################################################################
-- #  001_init.sql
-- ###########################################################################

-- CardVault :: initial schema
-- Time-series card price intelligence for FIFA World Cup 2026 trading cards.
-- Postgres 16+. Requires: pg_trgm, unaccent, vector (pgvector), btree_gin.

CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS unaccent;
CREATE EXTENSION IF NOT EXISTS btree_gin;
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ---------------------------------------------------------------------------
-- Reference: products, cards, parallels, SKUs
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS products (
  code            TEXT PRIMARY KEY,              -- 'A', 'B'
  name            TEXT NOT NULL,                 -- 'Donruss Road to WC 25/26'
  manufacturer    TEXT,
  season          TEXT,
  release_date    DATE,
  notes           TEXT
);

CREATE TABLE IF NOT EXISTS cards (
  id              BIGSERIAL PRIMARY KEY,
  legacy_id       TEXT UNIQUE NOT NULL,          -- 'A|Base|1' from the HTML tracker
  product_code    TEXT NOT NULL REFERENCES products(code),
  section         TEXT NOT NULL,                 -- 'Base', 'Kaboom!', 'Signature Series'
  card_number     TEXT NOT NULL,
  player          TEXT NOT NULL,
  team            TEXT,
  subset          TEXT DEFAULT '',               -- 'RR' = Rated Rookie
  is_rookie       BOOLEAN DEFAULT FALSE,
  is_auto         BOOLEAN DEFAULT FALSE,
  is_insert       BOOLEAN DEFAULT FALSE,
  seed_est_aud    NUMERIC(12,2),                 -- hand-seeded estimate carried over
  hot             BOOLEAN DEFAULT FALSE,
  -- search + AI matching
  search_text     TEXT,
  embedding       vector(1536),
  created_at      TIMESTAMPTZ DEFAULT now(),
  UNIQUE (product_code, section, card_number)
);

CREATE INDEX IF NOT EXISTS cards_player_trgm  ON cards USING gin (player gin_trgm_ops);
CREATE INDEX IF NOT EXISTS cards_search_trgm  ON cards USING gin (search_text gin_trgm_ops);
CREATE INDEX IF NOT EXISTS cards_section_idx  ON cards (product_code, section);
CREATE INDEX IF NOT EXISTS cards_embedding_idx ON cards USING hnsw (embedding vector_cosine_ops);

-- Parallels are defined per (product, section); a NULL card_id means
-- "applies to every card in that section".
CREATE TABLE IF NOT EXISTS parallels (
  id              BIGSERIAL PRIMARY KEY,
  product_code    TEXT NOT NULL REFERENCES products(code),
  section          TEXT NOT NULL,
  name            TEXT NOT NULL,
  print_run       INTEGER,                       -- 10, 25, 99 ... NULL = unnumbered
  is_numbered     BOOLEAN GENERATED ALWAYS AS (print_run IS NOT NULL) STORED,
  -- multiplier applied to the base card value when no direct comps exist
  fallback_mult   NUMERIC(8,3),
  aliases         TEXT[] DEFAULT '{}',           -- title-matching synonyms
  UNIQUE (product_code, section, name)
);
CREATE INDEX IF NOT EXISTS parallels_name_trgm ON parallels USING gin (name gin_trgm_ops);

-- A SKU is the actual tradeable unit: card + parallel + grade.
CREATE TABLE IF NOT EXISTS skus (
  id              BIGSERIAL PRIMARY KEY,
  card_id         BIGINT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  parallel_id     BIGINT REFERENCES parallels(id) ON DELETE SET NULL,
  grader          TEXT,                          -- NULL = raw; 'PSA','BGS','SGC','CGC'
  grade           NUMERIC(3,1),                  -- 10, 9.5, 9 ...
  label           TEXT NOT NULL,                 -- denormalized human label
  created_at      TIMESTAMPTZ DEFAULT now(),
  UNIQUE (card_id, parallel_id, grader, grade)
);
CREATE INDEX IF NOT EXISTS skus_card_idx ON skus (card_id);
-- NULLS NOT DISTINCT keeps the unique constraint meaningful for raw/base SKUs
-- IF EXISTS because this statement runs a second time whenever the schema is applied as one
-- bundled file (db/cardvault.sql). Without it the constraint is already gone, the statement
-- errors, and - since the bundle is one transaction - EVERY later migration in the file is
-- rolled back. The failure mode is the nasty one: the file appears to run, the schema does
-- not change, and it looks like the bundle simply had nothing to do.
ALTER TABLE skus DROP CONSTRAINT IF EXISTS skus_card_id_parallel_id_grader_grade_key;
CREATE UNIQUE INDEX IF NOT EXISTS skus_identity ON skus (card_id, parallel_id, grader, grade) NULLS NOT DISTINCT;

-- ---------------------------------------------------------------------------
-- Marketplaces, fees, FX
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS marketplaces (
  code            TEXT PRIMARY KEY,              -- 'EBAY_AU', 'MERCARI_JP', 'ML_MX'
  name            TEXT NOT NULL,
  region          TEXT NOT NULL,                 -- 'AU','US','UK','DE','JP','MX','SG'
  currency        CHAR(3) NOT NULL,
  ebay_marketplace_id TEXT,                      -- for the eBay APIs
  -- economics (verify against the live fee schedule; see docs/FEES.md)
  fee_pct         NUMERIC(6,4) NOT NULL DEFAULT 0.1325,
  fee_fixed       NUMERIC(8,2) NOT NULL DEFAULT 0.40,
  fee_fixed_ccy   CHAR(3),
  intl_fee_pct    NUMERIC(6,4) NOT NULL DEFAULT 0,   -- surcharge when buyer is offshore
  payment_fee_pct NUMERIC(6,4) NOT NULL DEFAULT 0,
  ad_rate_typical NUMERIC(6,4) NOT NULL DEFAULT 0,   -- promoted-listing rate you'd realistically run
  -- friction
  ship_from_au_cost NUMERIC(8,2),                -- AUD, tracked small parcel
  ship_days_est   INTEGER,
  customs_risk    NUMERIC(4,2) DEFAULT 0,        -- 0..1, buyer-side duty/tariff drag on demand
  requires_local_entity BOOLEAN DEFAULT FALSE,
  -- Fraction of open-market price this venue actually realizes, BEFORE fees.
  -- Without this, any zero-fee venue (a local shop, a Facebook group) looks like
  -- a 100%-keep sale and outranks eBay on every card — which is exactly backwards
  -- for anything valuable: a shop pays 40-60% of market precisely because it is
  -- instant and fee-free. Auction houses can exceed 1.0 at the top end.
  price_realization NUMERIC(5,3) NOT NULL DEFAULT 1.000,
  -- The value band where this venue makes sense at all.
  min_value_aud   NUMERIC(12,2) NOT NULL DEFAULT 0,
  max_value_aud   NUMERIC(12,2),
  -- demand
  audience_note   TEXT,
  active          BOOLEAN DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS fx_rates (
  as_of           DATE NOT NULL,
  base            CHAR(3) NOT NULL,
  quote           CHAR(3) NOT NULL,
  rate            NUMERIC(18,8) NOT NULL,
  source          TEXT,
  PRIMARY KEY (as_of, base, quote)
);

-- ---------------------------------------------------------------------------
-- Ingestion: raw listings -> matched comps
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS sources (
  code            TEXT PRIMARY KEY,              -- 'ebay_browse','ebay_insights','brightdata_ebay_sold', ...
  name            TEXT NOT NULL,
  kind            TEXT NOT NULL,                 -- 'api' | 'scrape' | 'manual'
  gives_sold      BOOLEAN NOT NULL,              -- true = realized sales, false = asks
  trust_weight    NUMERIC(4,2) NOT NULL DEFAULT 1.0,
  enabled         BOOLEAN DEFAULT TRUE,
  config          JSONB DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS source_runs (
  id              BIGSERIAL PRIMARY KEY,
  source_code     TEXT NOT NULL REFERENCES sources(code),
  marketplace_code TEXT REFERENCES marketplaces(code),
  started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at     TIMESTAMPTZ,
  status          TEXT NOT NULL DEFAULT 'running', -- running|ok|partial|error
  query           TEXT,
  items_seen      INTEGER DEFAULT 0,
  items_new       INTEGER DEFAULT 0,
  cost_units      NUMERIC(12,4) DEFAULT 0,       -- API credits / scrape requests spent
  error           TEXT
);
CREATE INDEX IF NOT EXISTS source_runs_recent ON source_runs (source_code, started_at DESC);

CREATE TABLE IF NOT EXISTS listings (
  id              BIGSERIAL PRIMARY KEY,
  source_code     TEXT NOT NULL REFERENCES sources(code),
  marketplace_code TEXT NOT NULL REFERENCES marketplaces(code),
  external_id     TEXT NOT NULL,
  title           TEXT NOT NULL,
  url             TEXT,
  image_url       TEXT,
  price           NUMERIC(14,2),
  currency        CHAR(3),
  shipping        NUMERIC(14,2) DEFAULT 0,
  is_sold         BOOLEAN NOT NULL DEFAULT FALSE,
  sold_at         TIMESTAMPTZ,
  observed_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  seller          TEXT,
  seller_country  TEXT,
  condition_text  TEXT,
  bids            INTEGER,
  format          TEXT,                          -- 'auction' | 'fixed' | 'best_offer'
  quantity        INTEGER DEFAULT 1,
  raw             JSONB,
  UNIQUE (source_code, marketplace_code, external_id)
);
CREATE INDEX IF NOT EXISTS listings_title_trgm ON listings USING gin (title gin_trgm_ops);
CREATE INDEX IF NOT EXISTS listings_sold_at    ON listings (sold_at DESC) WHERE is_sold;
CREATE INDEX IF NOT EXISTS listings_observed   ON listings (observed_at DESC);

-- One row per (listing -> SKU) resolution attempt.
CREATE TABLE IF NOT EXISTS comps (
  id              BIGSERIAL PRIMARY KEY,
  listing_id      BIGINT NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  sku_id          BIGINT REFERENCES skus(id) ON DELETE CASCADE,
  marketplace_code TEXT NOT NULL REFERENCES marketplaces(code),
  sold_at         TIMESTAMPTZ NOT NULL,
  price_native    NUMERIC(14,2) NOT NULL,        -- item + shipping
  currency        CHAR(3) NOT NULL,
  price_aud       NUMERIC(14,2) NOT NULL,
  price_usd       NUMERIC(14,2) NOT NULL,
  is_sold         BOOLEAN NOT NULL DEFAULT TRUE,
  -- matching provenance
  match_method    TEXT NOT NULL,                 -- 'exact_num' | 'trgm' | 'embedding' | 'llm' | 'manual'
  match_confidence NUMERIC(4,3) NOT NULL,
  parsed          JSONB,                         -- output of the title parser
  -- quality control
  excluded        BOOLEAN NOT NULL DEFAULT FALSE,
  exclude_reason  TEXT,                          -- 'lot','reprint','custom','outlier_mad','low_conf','wrong_player'
  created_at      TIMESTAMPTZ DEFAULT now(),
  UNIQUE (listing_id)
);
CREATE INDEX IF NOT EXISTS comps_sku_time ON comps (sku_id, sold_at DESC) WHERE NOT excluded;
CREATE INDEX IF NOT EXISTS comps_mkt_time ON comps (marketplace_code, sold_at DESC) WHERE NOT excluded;

-- ---------------------------------------------------------------------------
-- Derived: valuations, velocity, recommendations
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS valuations (
  id              BIGSERIAL PRIMARY KEY,
  sku_id          BIGINT NOT NULL REFERENCES skus(id) ON DELETE CASCADE,
  marketplace_code TEXT REFERENCES marketplaces(code),  -- NULL = global blended
  as_of           TIMESTAMPTZ NOT NULL DEFAULT now(),
  window_days     INTEGER NOT NULL DEFAULT 90,
  n_comps         INTEGER NOT NULL,
  median_aud      NUMERIC(14,2),
  trimmed_mean_aud NUMERIC(14,2),
  p25_aud         NUMERIC(14,2),
  p75_aud         NUMERIC(14,2),
  low_aud         NUMERIC(14,2),
  high_aud        NUMERIC(14,2),
  -- time-weighted fair value: the number the UI shows
  fair_value_aud  NUMERIC(14,2),
  trend_30d_pct   NUMERIC(8,3),                  -- % change in rolling median
  trend_90d_pct   NUMERIC(8,3),
  volatility      NUMERIC(8,4),                  -- MAD / median
  method          TEXT NOT NULL,                 -- 'comps' | 'parallel_mult' | 'tier_avg' | 'seed'
  confidence      NUMERIC(4,3) NOT NULL
);
-- NULLS NOT DISTINCT is load-bearing: marketplace_code IS NULL means "global
-- blended valuation", and a plain UNIQUE constraint treats NULLs as distinct, so
-- every re-run would insert a duplicate global row instead of updating it.
CREATE UNIQUE INDEX IF NOT EXISTS valuations_identity
  ON valuations (sku_id, marketplace_code, as_of, window_days) NULLS NOT DISTINCT;
CREATE INDEX IF NOT EXISTS valuations_latest ON valuations (sku_id, as_of DESC);

CREATE TABLE IF NOT EXISTS velocity (
  sku_id          BIGINT NOT NULL REFERENCES skus(id) ON DELETE CASCADE,
  marketplace_code TEXT REFERENCES marketplaces(code),
  as_of           DATE NOT NULL,
  window_days     INTEGER NOT NULL,
  sales_count     INTEGER NOT NULL DEFAULT 0,
  active_listings INTEGER,
  sell_through    NUMERIC(6,4),                  -- sold / (sold + active)
  sales_per_day   NUMERIC(10,4),
  days_to_sell_est NUMERIC(10,2)
);
-- Same reason as valuations: a PRIMARY KEY would make marketplace_code NOT NULL,
-- but NULL is how we record the cross-marketplace (global) figure.
CREATE UNIQUE INDEX IF NOT EXISTS velocity_identity
  ON velocity (sku_id, marketplace_code, as_of, window_days) NULLS NOT DISTINCT;

CREATE TABLE IF NOT EXISTS recommendations (
  id              BIGSERIAL PRIMARY KEY,
  sku_id          BIGINT NOT NULL REFERENCES skus(id) ON DELETE CASCADE,
  as_of           TIMESTAMPTZ NOT NULL DEFAULT now(),
  action          TEXT NOT NULL,                 -- 'sell_now','sell_soon','hold','grade_then_sell','lot_it','keep_watching'
  urgency         NUMERIC(4,3),
  best_marketplace_code TEXT REFERENCES marketplaces(code),
  best_net_aud    NUMERIC(14,2),
  runner_up_code  TEXT REFERENCES marketplaces(code),
  runner_up_net_aud NUMERIC(14,2),
  venue_ladder    JSONB,                         -- ranked marketplaces w/ net proceeds + reasoning
  communities     JSONB,                         -- ranked communities/channels
  grade_ev        JSONB,                         -- {raw, psa10_comp, gem_rate, cost, ev, verdict}
  timing          JSONB,                         -- {post_wc_decay_pct, half_life_days, sell_by}
  score           NUMERIC(8,3),
  reasoning       TEXT,
  model           TEXT,
  UNIQUE (sku_id, as_of)
);
CREATE INDEX IF NOT EXISTS recommendations_latest ON recommendations (sku_id, as_of DESC);

-- ---------------------------------------------------------------------------
-- Where to sell: communities / channels
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS communities (
  id              BIGSERIAL PRIMARY KEY,
  name            TEXT NOT NULL,
  kind            TEXT NOT NULL,                 -- 'marketplace','facebook_group','discord','reddit','whatnot','forum','lcs','show'
  region          TEXT,                          -- 'AU','US','GLOBAL','MX','JP', ...
  url             TEXT,
  fee_pct         NUMERIC(6,4) DEFAULT 0,
  audience_size   INTEGER,
  -- what this channel is actually good at moving
  focus_sections  TEXT[] DEFAULT '{}',           -- 'Kaboom!','Signature Series', ...
  focus_teams     TEXT[] DEFAULT '{}',           -- 'Mexico','Argentina', ...
  min_value_aud   NUMERIC(12,2) DEFAULT 0,       -- below this, not worth the effort
  max_value_aud   NUMERIC(12,2),                 -- above this, audience too small / trust issues
  likes_lots      BOOLEAN DEFAULT FALSE,
  likes_graded    BOOLEAN DEFAULT FALSE,
  speed_score     NUMERIC(4,2) DEFAULT 0.5,      -- 0..1 how fast things move
  price_realization NUMERIC(4,2) DEFAULT 1.0,    -- vs eBay market, e.g. 0.85 for FB groups
  notes           TEXT,
  active          BOOLEAN DEFAULT TRUE
);

-- ---------------------------------------------------------------------------
-- Your collection
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS holdings (
  id              BIGSERIAL PRIMARY KEY,
  sku_id          BIGINT NOT NULL REFERENCES skus(id) ON DELETE CASCADE,
  qty             INTEGER NOT NULL DEFAULT 1,
  cost_basis_aud  NUMERIC(12,2),
  acquired_at     DATE,
  location        TEXT,
  price_override_aud NUMERIC(14,2),              -- your manual override (blue border in the old UI)
  notes           TEXT,
  updated_at      TIMESTAMPTZ DEFAULT now(),
  UNIQUE (sku_id)
);

CREATE TABLE IF NOT EXISTS sales (
  id              BIGSERIAL PRIMARY KEY,
  sku_id          BIGINT NOT NULL REFERENCES skus(id),
  qty             INTEGER NOT NULL DEFAULT 1,
  price_each      NUMERIC(14,2) NOT NULL,
  currency        CHAR(3) NOT NULL DEFAULT 'AUD',
  price_each_aud  NUMERIC(14,2) NOT NULL,
  marketplace_code TEXT REFERENCES marketplaces(code),
  community_id    BIGINT REFERENCES communities(id),
  fees_aud        NUMERIC(14,2) DEFAULT 0,
  shipping_aud    NUMERIC(14,2) DEFAULT 0,
  net_aud         NUMERIC(14,2),
  sold_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  notes           TEXT
);
CREATE INDEX IF NOT EXISTS sales_time ON sales (sold_at DESC);

-- ---------------------------------------------------------------------------
-- Alerts + watchlist
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS watchlist (
  id              BIGSERIAL PRIMARY KEY,
  sku_id          BIGINT REFERENCES skus(id) ON DELETE CASCADE,
  query           TEXT,                          -- free-text saved search
  rule            JSONB NOT NULL,                -- {type:'price_drop',pct:15} etc
  channel         TEXT DEFAULT 'log',            -- 'log','webhook','email'
  target          TEXT,
  last_fired_at   TIMESTAMPTZ,
  active          BOOLEAN DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS alerts (
  id              BIGSERIAL PRIMARY KEY,
  watchlist_id    BIGINT REFERENCES watchlist(id) ON DELETE CASCADE,
  sku_id          BIGINT REFERENCES skus(id) ON DELETE CASCADE,
  fired_at        TIMESTAMPTZ DEFAULT now(),
  severity        TEXT DEFAULT 'info',
  title           TEXT NOT NULL,
  body            TEXT,
  payload         JSONB
);

-- ---------------------------------------------------------------------------
-- AI query audit (NL -> SQL)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS ai_queries (
  id              BIGSERIAL PRIMARY KEY,
  asked_at        TIMESTAMPTZ DEFAULT now(),
  question        TEXT NOT NULL,
  generated_sql   TEXT,
  row_count       INTEGER,
  answer          TEXT,
  model           TEXT,
  tokens_in       INTEGER,
  tokens_out      INTEGER,
  ms              INTEGER,
  error           TEXT
);

-- ---------------------------------------------------------------------------
-- Convenience views
-- ---------------------------------------------------------------------------

DROP VIEW IF EXISTS sku_detail CASCADE;
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
       s.grade
FROM skus s
JOIN cards c   ON c.id = s.card_id
JOIN products p ON p.code = c.product_code
LEFT JOIN parallels pa ON pa.id = s.parallel_id;

DROP VIEW IF EXISTS latest_valuation CASCADE;
CREATE VIEW latest_valuation AS
SELECT DISTINCT ON (sku_id, marketplace_code)
       sku_id, marketplace_code, as_of, n_comps, fair_value_aud, median_aud,
       low_aud, high_aud, trend_30d_pct, trend_90d_pct, volatility, method, confidence
FROM valuations
ORDER BY sku_id, marketplace_code, as_of DESC;

DROP VIEW IF EXISTS latest_recommendation CASCADE;
CREATE VIEW latest_recommendation AS
SELECT DISTINCT ON (sku_id) *
FROM recommendations
ORDER BY sku_id, as_of DESC;

DROP VIEW IF EXISTS portfolio CASCADE;
CREATE VIEW portfolio AS
SELECT h.id            AS holding_id,
       h.sku_id,
       d.label,
       d.player, d.team, d.section, d.product_name, d.card_number,
       d.parallel_name, d.grader, d.grade,
       h.qty,
       h.cost_basis_aud,
       COALESCE(h.price_override_aud, v.fair_value_aud, d.seed_est_aud) AS unit_value_aud,
       COALESCE(h.price_override_aud, v.fair_value_aud, d.seed_est_aud) * h.qty AS total_value_aud,
       v.n_comps, v.trend_30d_pct, v.confidence, v.as_of AS priced_at,
       r.action, r.best_marketplace_code, r.best_net_aud, r.score
FROM holdings h
JOIN sku_detail d ON d.sku_id = h.sku_id
LEFT JOIN latest_valuation v ON v.sku_id = h.sku_id AND v.marketplace_code IS NULL
LEFT JOIN latest_recommendation r ON r.sku_id = h.sku_id;

-- ###########################################################################
-- #  002_reference_data.sql
-- ###########################################################################

-- CardVault :: reference data
-- Fee rates, shipping costs and community metadata are STARTING POINTS.
-- They live in the DB precisely so you can tune them without a redeploy.
-- See docs/FEES.md before trusting the "where to sell" output for a big card.

INSERT INTO products (code, name, manufacturer, season, release_date) VALUES
  ('A', 'Donruss Road to World Cup 25/26', 'Panini', '2025-26', '2025-11-01'),
  ('B', 'Panini FIFA World Cup 2026',      'Panini', '2026',    '2026-04-01')
ON CONFLICT (code) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Marketplaces
-- fee_pct / fee_fixed verified July 2026 for eBay trading cards (13.25% + $0.40
-- US, non-store). Other sites are best-effort; confirm before relying on them.
-- ship_from_au_cost = tracked small parcel from Australia, in AUD.
-- ---------------------------------------------------------------------------
INSERT INTO marketplaces
 (code, name, region, currency, ebay_marketplace_id, fee_pct, fee_fixed, fee_fixed_ccy,
  intl_fee_pct, payment_fee_pct, ad_rate_typical, ship_from_au_cost, ship_days_est,
  customs_risk, requires_local_entity, price_realization, min_value_aud, max_value_aud,
  audience_note)
VALUES
 ('EBAY_AU','eBay Australia','AU','AUD','EBAY_AU',0.1325,0.40,'AUD',
  0.0000,0.0000,0.0200, 9.00, 4, 0.00, FALSE,
  1.000,3,NULL,
  'Home market. No FX loss, no customs, cheapest postage, but the thinnest bidder pool for soccer.'),
 ('EBAY_US','eBay United States','US','USD','EBAY_US',0.1325,0.40,'USD',
  0.0165,0.0000,0.0200, 18.00, 12, 0.35, FALSE,
  1.000,15,NULL,
  'Deepest sports-card money on earth. Best for Kabooms, autos, low-numbered parallels. US card tariffs add buyer friction.'),
 ('EBAY_UK','eBay United Kingdom','UK','GBP','EBAY_UK',0.1300,0.30,'GBP',
  0.0165,0.0000,0.0200, 16.00, 10, 0.25, FALSE,
  1.000,15,NULL,
  'Strong football (not "soccer") culture. England/Wales players and Premier League names over-index here.'),
 ('EBAY_DE','eBay Germany','DE','EUR','EBAY_DE',0.1100,0.35,'EUR',
  0.0165,0.0000,0.0200, 16.00, 10, 0.30, FALSE,
  1.000,15,NULL,
  'Lower fees. Big Bundesliga/Germany collector base; Panini is the native brand in Europe.'),
 ('EBAY_ES','eBay Spain','ES','EUR','EBAY_ES',0.1100,0.35,'EUR',
  0.0165,0.0000,0.0200, 16.00, 11, 0.30, FALSE,
  1.000,15,NULL,
  'Yamal, Spain squad, La Liga names. Smaller pool but very targeted demand.'),
 ('EBAY_JP','eBay Japan (cross-border)','JP','USD','EBAY_JP',0.1325,0.40,'USD',
  0.0165,0.0000,0.0200, 15.00, 8, 0.10, FALSE,
  1.000,20,NULL,
  'Thin for soccer, but Japanese buyers pay up for graded/pristine and for Japan squad players.'),
 ('MERCARI_JP','Mercari Japan','JP','JPY',NULL,0.1000,0.00,'JPY',
  0.0000,0.0000,0.0000, 15.00, 9, 0.10, TRUE,
  0.950,10,4000,
  'Cheap 10% flat fee and real Japanese demand, but effectively needs a JP address/bank — use a proxy service (Buyee/Tenso) or skip.'),
 ('YAHOO_JP','Yahoo! Auctions Japan','JP','JPY',NULL,0.1000,0.00,'JPY',
  0.0000,0.0000,0.0000, 15.00, 9, 0.10, TRUE,
  0.980,10,8000,
  'Where Japanese collectors actually bid. Same local-entity problem as Mercari.'),
 ('ML_MX','MercadoLibre Mexico','MX','MXN',NULL,0.1600,10.00,'MXN',
  0.0000,0.0400,0.0000, 22.00, 18, 0.40, TRUE,
  1.000,10,3000,
  'Host-nation demand engine for 2026. Gilberto Mora and the Mexico squad command a premium here that eBay does not see. High fees, hard cross-border logistics.'),
 ('ML_AR','MercadoLibre Argentina','AR','ARS',NULL,0.1600,0.00,'ARS',
  0.0000,0.0400,0.0000, 24.00, 22, 0.60, TRUE,
  1.000,10,2000,
  'Messi country. Enormous passion, brutal FX/capital controls and import restrictions — usually better to reach these buyers via eBay US.'),
 ('SHOPEE_SG','Shopee Singapore','SG','SGD',NULL,0.0800,0.00,'SGD',
  0.0000,0.0200,0.0000, 12.00, 8, 0.10, TRUE,
  0.850,5,600,
  'Cheap fees, growing SEA card scene, but low ceiling — commons and mid-tier only.'),
 ('WHATNOT_AU','Whatnot (live auction)','AU','AUD',NULL,0.0800,0.00,'AUD',
  0.0000,0.0290,0.0000, 9.00, 4, 0.00, FALSE,
  0.870,10,3000,
  'Live-stream auctions. Excellent for clearing volume/lots fast at ~80-90% of eBay price. 8% + payment fee.'),
 ('PWCC','Fanatics Collect / PWCC weekly','US','USD',NULL,0.2000,0.00,'USD',
  0.0000,0.0000,0.0000, 25.00, 21, 0.35, FALSE,
  1.150,1500,NULL,
  'Consignment auction house. Only worth it above ~A$1500: their bidder pool sets records on Kabooms and 1/1s. ~20% all-in seller cost.'),
 ('GOLDIN','Goldin Auctions','US','USD',NULL,0.2000,0.00,'USD',
  0.0000,0.0000,0.0000, 25.00, 28, 0.35, FALSE,
  1.200,5000,NULL,
  'Top-end only, A$5k+. Buyer premium does the work; seller cost negotiable at high value.'),
 ('FACEBOOK_AU','Facebook groups (AU)','AU','AUD',NULL,0.0000,0.00,'AUD',
  0.0000,0.0000,0.0000, 5.00, 3, 0.00, FALSE,
  0.870,15,400,
  'Zero fees, PayID/bank transfer, fast for A$20-300. Price realization ~85-90% of eBay. Scam risk both ways.'),
 ('LOCAL_LCS','Local card shop / show','AU','AUD',NULL,0.0000,0.00,'AUD',
  0.0000,0.0000,0.0000, 0.00, 0, 0.00, FALSE,
  0.500,0,NULL,
  'Instant cash, but shops buy at 40-60% of market. Only for bulk clearing.')
ON CONFLICT (code) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Sources
-- ---------------------------------------------------------------------------
INSERT INTO sources (code, name, kind, gives_sold, trust_weight, enabled, config) VALUES
 ('ebay_browse',   'eBay Browse API (active listings)', 'api',    FALSE, 0.55, TRUE,
   '{"note":"Asking prices. Used for supply/sell-through, and as a weak price signal only."}'),
 ('ebay_insights', 'eBay Marketplace Insights API (90d sold)', 'api', TRUE, 1.00, FALSE,
   '{"note":"Limited-release: requires an application to eBay. Highest-quality sold data when granted."}'),
 ('brightdata_ebay_sold', 'Bright Data - eBay sold listings', 'scrape', TRUE, 0.90, FALSE,
   '{"note":"Costs per request. Best fallback for sold comps when Insights is not approved."}'),
 ('brightdata_serp', 'Bright Data - SERP discovery', 'scrape', FALSE, 0.40, FALSE, '{}'),
 ('scrape_sportscardspro', 'SportsCardsPro sold history', 'scrape', TRUE, 0.85, FALSE,
   '{"note":"Aggregated sold data. Respect robots.txt and their terms; low request rate."}'),
 ('scrape_130point', '130point sold search', 'scrape', TRUE, 0.85, FALSE,
   '{"note":"Aggregates eBay + Goldin + PWCC sold. Manual/low-volume use."}'),
 ('csv_import',    'Manual CSV / clipboard comps', 'manual', TRUE, 1.00, TRUE, '{}'),
 ('manual_entry',  'Manual price override', 'manual', TRUE, 1.00, TRUE, '{}')
ON CONFLICT (code) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Communities / channels
-- price_realization is relative to eBay market price; speed_score is 0..1.
-- ---------------------------------------------------------------------------
INSERT INTO communities
 (name, kind, region, url, fee_pct, audience_size, focus_sections, focus_teams,
  min_value_aud, max_value_aud, likes_lots, likes_graded, speed_score, price_realization, notes)
VALUES
 ('r/soccercards','reddit','GLOBAL','https://reddit.com/r/soccercards',0.0000,120000,
  '{}','{}',30,3000,FALSE,TRUE,0.60,0.92,
  'The default global soccer-card room. Sale threads + a lot of price discovery. Build comment history before selling.'),
 ('r/footballcards','reddit','GLOBAL','https://reddit.com/r/footballcards',0.0000,40000,
  '{}','{}',30,2000,FALSE,TRUE,0.50,0.90,
  'Europe-leaning overlap with r/soccercards.'),
 ('Soccer Cards HQ Discord','discord','GLOBAL',NULL,0.0000,25000,
  '{Kaboom!,"Signature Series","Beautiful Game Autographs"}','{}',100,20000,FALSE,TRUE,0.75,0.95,
  'Where the high-end soccer money actually talks. Best channel for Kabooms and autos without paying auction-house rates.'),
 ('Australian Sports Cards (FB)','facebook_group','AU',NULL,0.0000,45000,
  '{}','{}',20,1500,TRUE,FALSE,0.70,0.88,
  'Biggest AU group. Fast, fee-free, PayID. Great for A$20-300 singles and lots.'),
 ('Aussie Soccer / Football Cards (FB)','facebook_group','AU',NULL,0.0000,9000,
  '{}','{Australia}','15',800,TRUE,FALSE,0.60,0.85,
  'Smaller but exactly the right audience for Socceroos and A-League crossovers.'),
 ('Tarjetas y Estampas Mexico (FB)','facebook_group','MX',NULL,0.0000,30000,
  '{Base,"Rookie Kings"}','{Mexico}',15,1200,TRUE,FALSE,0.65,1.05,
  'Host-nation heat. Mexico squad and Gilberto Mora rookies clear ABOVE eBay AU here. Payment via MercadoPago/transfer is the friction.'),
 ('Argentina Cartas de Futbol (FB)','facebook_group','AR',NULL,0.0000,35000,
  '{}','{Argentina}',20,2000,FALSE,FALSE,0.60,1.00,
  'Messi/Argentina demand. FX and shipping make settlement painful; treat as a lead source, close on eBay US.'),
 ('Blowout Forums - Soccer','forum','US','https://blowoutforums.com',0.0000,15000,
  '{Kaboom!,"Signature Series"}','{}',80,15000,FALSE,TRUE,0.55,0.95,
  'Old-school US forum. Serious buyers, low fees, slow but honest.'),
 ('Whatnot soccer breaks/auctions','whatnot','GLOBAL','https://whatnot.com',0.0800,200000,
  '{}','{}',10,1500,TRUE,TRUE,0.90,0.85,
  'Fastest liquidity for volume. Ideal for the "sell in player lots" problem with A$2-5 base cards.'),
 ('eBay AU store','marketplace','AU',NULL,0.1325,0,
  '{}','{}',5,NULL,TRUE,TRUE,0.65,1.00,
  'Baseline. Everything is measured against this.'),
 ('eBay US','marketplace','US',NULL,0.1490,0,
  '{}','{}',15,NULL,TRUE,TRUE,0.70,1.00,
  'Baseline for anything above ~A$100.'),
 ('Card shows (AU capital cities)','show','AU',NULL,0.0000,0,
  '{}','{}',50,5000,TRUE,TRUE,0.40,0.90,
  'Good for moving a box of mid-tier in one day. Dealers lowball; collector table sales are fine.'),
 ('Mana Market / Slabbys community','lcs','AU',NULL,0.0000,0,
  '{}','{}',50,NULL,FALSE,TRUE,0.45,0.85,
  'Grading middlemen who also broker. Useful pairing: grade + sell through the same relationship.')
ON CONFLICT DO NOTHING;

-- Seed FX so a cold start can still price things. The worker refreshes daily.
INSERT INTO fx_rates (as_of, base, quote, rate, source) VALUES
 (CURRENT_DATE,'USD','AUD',1.4000,'seed'),
 (CURRENT_DATE,'AUD','USD',0.7143,'seed'),
 (CURRENT_DATE,'GBP','AUD',1.9200,'seed'),
 (CURRENT_DATE,'EUR','AUD',1.6300,'seed'),
 (CURRENT_DATE,'JPY','AUD',0.0094,'seed'),
 (CURRENT_DATE,'MXN','AUD',0.0760,'seed'),
 (CURRENT_DATE,'ARS','AUD',0.0011,'seed'),
 (CURRENT_DATE,'SGD','AUD',1.0900,'seed'),
 (CURRENT_DATE,'AUD','AUD',1.0000,'seed')
ON CONFLICT DO NOTHING;

-- ###########################################################################
-- #  003_images.sql
-- ###########################################################################

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

-- ###########################################################################
-- #  004_boxes_types_custom.sql
-- ###########################################################################

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

-- ###########################################################################
-- #  005_box_reference.sql
-- ###########################################################################

-- CardVault :: box / pack configurations
--
-- `verified = TRUE` means the configuration was corroborated by product coverage.
-- `verified = FALSE` and `availability = 'reported_exclusive'` mean a source
-- claimed it and I could not confirm it elsewhere — the UI labels those as
-- reported rather than presenting them as fact. Correct any of it with SQL; see
-- docs/BOXES.md.

-- ---------------------------------------------------------------------------
-- A · Donruss Road to FIFA World Cup 25/26
-- Configurations per cardlines.com product review (packs/box, cards/pack, and
-- the per-box contents breakdown).
-- ---------------------------------------------------------------------------
INSERT INTO product_boxes
 (product_code, name, channel, packs_per_box, cards_per_pack, cards_per_box,
  guaranteed, contents_note, verified, source_url, sort_order)
VALUES
 ('A','Hobby','hobby',12,30,360,
  '1 autograph + 1 memorabilia card',
  'Per box: 6 numbered parallels, 12 Optic Holo parallels, 48 inserts or insert parallels.',
  TRUE,'https://cardlines.com/a-review-of-2025-26-panini-donruss-road-to-fifa-world-cup-soccer/',10),

 ('A','Hobby International','international',12,30,360,
  '1 autograph',
  'Per box: 3 numbered parallels, 12 Optic Argyle parallels, 48 inserts or insert parallels. Optic Argyle is only found in this configuration.',
  TRUE,'https://cardlines.com/a-review-of-2025-26-panini-donruss-road-to-fifa-world-cup-soccer/',20),

 ('A','Blaster','retail',6,15,90,
  '6 Rated Rookies',
  'Per box: 1 numbered parallel, 1 Optic Holo, 18 inserts or insert parallels. The cheapest way in, and the thinnest.',
  TRUE,'https://cardlines.com/a-review-of-2025-26-panini-donruss-road-to-fifa-world-cup-soccer/',30),

 ('A','Fat Pack','retail',12,25,300,
  '2 Rated Rookies',
  'Per box: 2 parallels, 3 Optic base or Rated Rookies, 3 inserts or insert parallels.',
  TRUE,'https://cardlines.com/a-review-of-2025-26-panini-donruss-road-to-fifa-world-cup-soccer/',40),

-- ---------------------------------------------------------------------------
-- B · Panini x Kayou FIFA World Cup 2026
-- ---------------------------------------------------------------------------
 ('B','Premium Hobby','hobby',10,6,60,
  NULL,
  '769 cards in the base checklist before parallels. Roughly 3-4 base and 2-3 inserts per pack.',
  TRUE,'https://www.rednails2.com/sports-cards-boxes/soccer-other/2026-panini-x-kayou-fifa-world-cup-soccer-premium-hobby-box/',10)
ON CONFLICT (product_code, name) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Which sections come out of which box
-- ---------------------------------------------------------------------------

-- Everything in product A is in the Hobby box.
INSERT INTO box_contents (box_id, section, availability, note)
SELECT b.id, c.section, 'included', NULL
  FROM product_boxes b
  CROSS JOIN (SELECT DISTINCT section FROM cards WHERE product_code = 'A' AND NOT is_custom) c
 WHERE b.product_code = 'A' AND b.name = 'Hobby'
ON CONFLICT DO NOTHING;

-- Kaboom!: widely reported as a hobby-exclusive SSP, but the checklist sources
-- do not restrict it, so it is recorded as REPORTED rather than as fact. This
-- distinction matters — "hobby exclusive" is a selling point you shouldn't make
-- to a buyer unless it's true.
UPDATE box_contents bc SET availability = 'reported_exclusive',
       note = 'Reported as a Hobby-exclusive short print. Checklist sources do not confirm the restriction — verify before advertising it as hobby-only.'
  FROM product_boxes b
 WHERE bc.box_id = b.id AND b.product_code = 'A' AND b.name = 'Hobby'
   AND bc.section IN ('Kaboom!', 'Kaboom! Oversize');

-- Autographs and memorabilia are the guaranteed hobby hit.
UPDATE box_contents bc SET note = 'The guaranteed autograph hit in a Hobby box.'
  FROM product_boxes b
 WHERE bc.box_id = b.id AND b.product_code = 'A' AND b.name = 'Hobby'
   AND bc.section IN ('Signature Series','Beautiful Game Autographs','Beautiful Game Dual Autographs');

-- Hobby International: same checklist, one exclusive parallel line.
INSERT INTO box_contents (box_id, section, availability, note)
SELECT b.id, c.section, 'included', NULL
  FROM product_boxes b
  CROSS JOIN (SELECT DISTINCT section FROM cards WHERE product_code = 'A' AND NOT is_custom) c
 WHERE b.product_code = 'A' AND b.name = 'Hobby International'
ON CONFLICT DO NOTHING;

UPDATE box_contents bc SET availability = 'exclusive',
       note = 'Optic Argyle parallels are only found in Hobby International boxes.'
  FROM product_boxes b
 WHERE bc.box_id = b.id AND b.product_code = 'A' AND b.name = 'Hobby International'
   AND bc.section = 'Base Optic';

-- Blaster / Fat Pack: base, Optic and inserts, but no guaranteed auto or memo.
INSERT INTO box_contents (box_id, section, availability, note)
SELECT b.id, c.section, 'included', NULL
  FROM product_boxes b
  CROSS JOIN (SELECT DISTINCT section FROM cards
               WHERE product_code = 'A' AND NOT is_custom
                 AND section NOT IN ('Signature Series','Beautiful Game Autographs',
                                     'Beautiful Game Dual Autographs','Kaboom!','Kaboom! Oversize')) c
 WHERE b.product_code = 'A' AND b.name IN ('Blaster','Fat Pack')
ON CONFLICT DO NOTHING;

UPDATE box_contents bc SET note = 'Blasters guarantee 6 Rated Rookies — the reason to buy one.'
  FROM product_boxes b
 WHERE bc.box_id = b.id AND b.product_code = 'A' AND b.name = 'Blaster'
   AND bc.section IN ('Base','Base Optic','Rookie Kings');

-- Product B: one configuration, so everything comes from it.
INSERT INTO box_contents (box_id, section, availability, note)
SELECT b.id, c.section, 'included', NULL
  FROM product_boxes b
  CROSS JOIN (SELECT DISTINCT section FROM cards WHERE product_code = 'B' AND NOT is_custom) c
 WHERE b.product_code = 'B' AND b.name = 'Premium Hobby'
ON CONFLICT DO NOTHING;

UPDATE box_contents bc SET odds = '1:4067', availability = 'included',
       note = 'The Glory Cup Manka is limited to 5 copies at roughly 1 in 4,067 packs.'
  FROM product_boxes b
 WHERE bc.box_id = b.id AND b.product_code = 'B' AND b.name = 'Premium Hobby'
   AND bc.section = 'Glory Cup';

UPDATE box_contents bc SET note = 'Gilded cards are numbered to 299; Gold Etched to 399 and /5.'
  FROM product_boxes b
 WHERE bc.box_id = b.id AND b.product_code = 'B' AND b.name = 'Premium Hobby'
   AND bc.section IN ('Gold Leaf','Golden');

-- ###########################################################################
-- #  006_players.sql
-- ###########################################################################

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

-- ###########################################################################
-- #  007_nation_kits.sql
-- ###########################################################################

-- CardVault :: national kit colours
--
-- Gives every player a distinct picture immediately, with no AI and no rights
-- problem: the avatar silhouette sits on their nation's kit colours and pattern.
-- Argentina reads as sky-blue stripes, Croatia as red checks, the Netherlands as
-- orange — 56 nations, instantly told apart in a grid.
--
-- `verified` marks the ones I'm confident about. Anything false is a best guess and
-- may be wrong; anything absent falls back to a neutral tint derived from the name
-- rather than asserting a colour. Correct any of it with SQL — see docs/PLAYER-ART.md.

CREATE TABLE IF NOT EXISTS nation_kits (
  team            TEXT PRIMARY KEY,
  primary_hex     TEXT NOT NULL,
  secondary_hex   TEXT NOT NULL,
  -- 'solid' | 'stripes' | 'checks' | 'halves'
  pattern         TEXT NOT NULL DEFAULT 'solid',
  verified        BOOLEAN NOT NULL DEFAULT FALSE,
  note            TEXT
);

INSERT INTO nation_kits (team, primary_hex, secondary_hex, pattern, verified, note) VALUES
  -- Instantly recognisable home kits.
  ('Argentina',        '#75AADB', '#FFFFFF', 'stripes', TRUE,  'Sky blue and white vertical stripes.'),
  ('Brazil',           '#FFDF00', '#009739', 'solid',   TRUE,  'Canary yellow, green trim.'),
  ('Netherlands',      '#FF6200', '#FFFFFF', 'solid',   TRUE,  'Oranje.'),
  ('Croatia',          '#FF0000', '#FFFFFF', 'checks',  TRUE,  'Red and white chequerboard.'),
  ('Italy',            '#0066B2', '#FFFFFF', 'solid',   TRUE,  'Azzurri.'),
  ('France',           '#001E62', '#FFFFFF', 'solid',   TRUE,  'Les Bleus.'),
  ('Germany',          '#FFFFFF', '#111111', 'solid',   TRUE,  'White with black.'),
  ('England',          '#FFFFFF', '#001E62', 'solid',   TRUE,  'White with navy.'),
  ('Spain',            '#C60B1E', '#FFD700', 'solid',   TRUE,  'La Roja.'),
  ('Portugal',         '#8B0000', '#006600', 'solid',   TRUE,  'Dark red with green.'),
  ('Uruguay',          '#5CBFEB', '#000000', 'solid',   TRUE,  'Celeste.'),
  ('Mexico',           '#006847', '#FFFFFF', 'solid',   TRUE,  'Green.'),
  ('United States',    '#FFFFFF', '#0A3161', 'solid',   TRUE,  'White with navy.'),
  ('Canada',           '#D52B1E', '#FFFFFF', 'solid',   TRUE,  'Red.'),
  ('Japan',            '#1B2F7A', '#FFFFFF', 'solid',   TRUE,  'Samurai Blue.'),
  ('Korea Republic',   '#CD2E3A', '#FFFFFF', 'solid',   TRUE,  'Red.'),
  ('Belgium',          '#E30613', '#000000', 'solid',   TRUE,  'Red Devils.'),
  ('Sweden',           '#FECB00', '#005293', 'solid',   TRUE,  'Yellow with blue.'),
  ('Norway',           '#BA0C2F', '#FFFFFF', 'solid',   TRUE,  'Red.'),
  ('Switzerland',      '#D52B1E', '#FFFFFF', 'solid',   TRUE,  'Red with white cross.'),
  ('Poland',           '#FFFFFF', '#DC143C', 'solid',   TRUE,  'White with red.'),
  ('Morocco',          '#C1272D', '#006233', 'solid',   TRUE,  'Red with green.'),
  ('Senegal',          '#FFFFFF', '#00853F', 'solid',   TRUE,  'White with green.'),
  ('Nigeria',          '#008751', '#FFFFFF', 'solid',   TRUE,  'Super Eagles green.'),
  ('Colombia',         '#FCD116', '#003893', 'solid',   TRUE,  'Yellow with blue.'),
  ('Paraguay',         '#D52B1E', '#FFFFFF', 'stripes', TRUE,  'Red and white stripes.'),
  ('Cymru',            '#C8102E', '#FFFFFF', 'solid',   TRUE,  'Wales — red.'),
  ('Scotland',         '#1B3A6B', '#FFFFFF', 'solid',   TRUE,  'Dark blue.'),
  ('Republic of Ireland','#169B62','#FFFFFF','solid',   TRUE,  'Green.'),
  ('Northern Ireland', '#00843D', '#FFFFFF', 'solid',   TRUE,  'Green.'),
  ('Australia',        '#FFCD00', '#00843D', 'solid',   TRUE,  'Socceroos gold.'),
  ('Qatar',            '#8A1538', '#FFFFFF', 'solid',   TRUE,  'Maroon.'),
  ('Saudi Arabia',     '#FFFFFF', '#006C35', 'solid',   TRUE,  'White with green.'),
  ('Serbia',           '#C6363C', '#0C4076', 'solid',   TRUE,  'Red with blue.'),
  ('Türkiye',          '#E30A17', '#FFFFFF', 'solid',   TRUE,  'Red.'),
  ('Egypt',            '#CE1126', '#FFFFFF', 'solid',   TRUE,  'Red.'),
  ('Ghana',            '#FFFFFF', '#CE1126', 'solid',   TRUE,  'White with red.'),
  ('Ecuador',          '#FFD100', '#003893', 'solid',   TRUE,  'Yellow with blue.'),
  ('Austria',          '#ED2939', '#FFFFFF', 'solid',   TRUE,  'Red.'),
  ('Czechia',          '#D7141A', '#FFFFFF', 'solid',   TRUE,  'Red.'),
  ('Ivory Coast',      '#F77F00', '#FFFFFF', 'solid',   TRUE,  'Orange.'),
  ('Algeria',          '#FFFFFF', '#007A3D', 'solid',   TRUE,  'White with green.'),
  ('Tunisia',          '#E70013', '#FFFFFF', 'solid',   TRUE,  'Red.'),
  ('Iran',             '#FFFFFF', '#239F40', 'solid',   TRUE,  'White with green.'),
  ('New Zealand',      '#FFFFFF', '#111111', 'solid',   TRUE,  'All Whites.'),
  ('South Africa',     '#FFB612', '#007A4D', 'solid',   TRUE,  'Bafana Bafana yellow.'),

  -- Less certain; shown but flagged so you can correct them.
  ('Bosnia and Herzegovina','#002F6C','#FFD100','solid', FALSE, 'Blue with yellow — verify.'),
  ('Iraq',             '#007A3D', '#FFFFFF', 'solid',   FALSE, 'Green — verify.'),
  ('Honduras',         '#FFFFFF', '#0073CF', 'solid',   FALSE, 'White with blue — verify.'),
  ('Cape Verde',       '#003893', '#FFFFFF', 'solid',   FALSE, 'Blue — verify.'),
  ('Congo DR',         '#007FFF', '#FFD100', 'solid',   FALSE, 'Blue — verify.'),
  ('Uzbekistan',       '#0099B5', '#FFFFFF', 'solid',   FALSE, 'Blue — verify.'),
  ('Curaçao',          '#002B7F', '#FFD100', 'solid',   FALSE, 'Blue with yellow — verify.'),
  ('Jordan',           '#FFFFFF', '#CE1126', 'solid',   FALSE, 'White with red — verify.'),
  ('Haiti',            '#00209F', '#D21034', 'solid',   FALSE, 'Blue with red — verify.'),
  ('Panama',           '#DA121A', '#005293', 'solid',   FALSE, 'Red with blue — verify.')
ON CONFLICT (team) DO NOTHING;

-- ###########################################################################
-- #  008_positions.sql
-- ###########################################################################

-- CardVault :: playing position, which selects the avatar pose
--
-- Identity stays data. Art stays a renderer. This migration is the join between
-- them: a position on the player row picks one of eight reusable poses, so 1,771
-- cards need eight pieces of art rather than 1,771.
--
-- `position` is deliberately nullable and deliberately unseeded for most of the
-- squad. An unknown position renders the neutral standing figure; it does not guess.
-- A defender drawn diving looks like a bug, and a guessed position is worse than no
-- position because it looks like data.
--
-- Three ways a position arrives, in order of authority:
--   'manual'   you set it, or you pinned a pose outright (pose_override)
--   'wikidata' P413 "position played on team / speciality", read during the portrait
--              backfill and matched on the item's label, not on a memorised QID
--   'seed'     the hand-checked list below

ALTER TABLE players ADD COLUMN IF NOT EXISTS position        TEXT;
ALTER TABLE players ADD COLUMN IF NOT EXISTS position_source TEXT;
-- A direct pose choice always wins over any position mapping. This is the escape
-- hatch for "I don't care what the data says, draw this one celebrating".
ALTER TABLE players ADD COLUMN IF NOT EXISTS pose_override   TEXT;

-- The hand-checked position list lives in db/seeds/positions.sql, because it matches on
-- player name and the migrations run before any cards exist. `npm run seed` applies it.

-- ###########################################################################
-- #  009_clubs.sql
-- ###########################################################################

-- CardVault :: club, as a third way to slice the collection
--
-- Nation comes free with the checklist (`cards.team` — these are World Cup products,
-- so team means country). Position arrived with 008. Club is the one the data doesn't
-- carry at all: Panini prints the national side, not the employer.
--
-- So it is stored on the player, nullable, with a source, and it is explicitly a
-- SNAPSHOT. Squad membership changes every window; a club filter that silently shows
-- last season's roster is worse than one that admits it doesn't know. `club_source`
-- and `fetched_at` are how you tell whether to trust a row:
--
--   'manual'   you set it
--   'wikidata' P54 "member of sports team", the statement with no end date
--   'seed'     the hand-checked list below, correct as at July 2026
--
-- Unknown stays NULL and the UI groups those under "Club unknown" rather than
-- guessing from nationality, which would be wrong for most of the squad.

ALTER TABLE players ADD COLUMN IF NOT EXISTS club        TEXT;
ALTER TABLE players ADD COLUMN IF NOT EXISTS club_source TEXT;

CREATE INDEX IF NOT EXISTS players_club_idx    ON players (club)     WHERE club IS NOT NULL;
CREATE INDEX IF NOT EXISTS players_position_idx ON players (position) WHERE position IS NOT NULL;

-- The hand-checked club list lives in db/seeds/clubs.sql — it matches on player name, and
-- on a fresh install the migrations run before the checklist is seeded. `npm run seed`
-- applies it after the cards are in.

-- ###########################################################################
-- #  010_club_provenance.sql
-- ###########################################################################

-- CardVault :: club provenance
--
-- A club is a snapshot that decays. The wrong response to that is hiding the filter
-- once the data ages: the Chelsea option existing yesterday and vanishing today is a
-- broken-looking UI, and the information didn't become useless — its *confidence*
-- changed. So record confidence and let freshness drive presentation only.
--
-- `club_resolution` is why we believe it, and it is deliberately separate from
-- `club_source` (where it came from):
--
--   single-current  exactly one open P54 statement — the good case
--   ambiguous       two or more still open (overlapping loans, a page mid-edit).
--                   Stores NO club. "Unknown" beats confidently wrong.
--   unknown         no P54 statements at all
--   manual          you set it; never overwritten by a backfill
--
-- `club_revision` is the Wikidata entity revision we read. `club_checked_at` alone
-- tells you when *we* looked; the revision tells you *what we looked at*, which is what
-- you actually need when a club turns out to be wrong and you want to know whether
-- Wikidata has changed since or whether our parse was at fault.

ALTER TABLE players ADD COLUMN IF NOT EXISTS club_resolution TEXT;
ALTER TABLE players ADD COLUMN IF NOT EXISTS club_checked_at TIMESTAMPTZ;
ALTER TABLE players ADD COLUMN IF NOT EXISTS club_revision   BIGINT;

-- Seeded rows were hand-checked when the migration was written, so they get a real
-- checked_at rather than NULL — otherwise every seeded club would show as never
-- verified, which is the opposite of the truth.
UPDATE players
   SET club_resolution = 'manual',
       club_checked_at = COALESCE(club_checked_at, TIMESTAMPTZ '2026-07-26 00:00:00+10')
 WHERE club IS NOT NULL
   AND club_source = 'seed'
   AND club_resolution IS NULL;

UPDATE players
   SET club_resolution = 'unknown'
 WHERE club IS NULL AND club_resolution IS NULL;

-- ###########################################################################
-- #  011_shadow_log.sql
-- ###########################################################################

-- CardVault :: shadow-mode decision log, and PSA population context
--
-- Two tables, one idea: record what we believed at the time, so that later we can ask
-- whether we were right — instead of quietly retuning weights against the same data
-- that produced them.
--
-- The scores (rarity / condition / market) deliberately do NOT feed the sell/hold
-- arithmetic. They are diagnostics. This table is how they earn the right to become
-- model inputs: log them beside the decision that was actually made, wait, then measure
-- whether they carried information the expected-value engine was missing. If they did,
-- the thing to promote is the *underlying variable* (momentum, sell-through, comp
-- velocity) — not the 0-100 score, which is a presentation artefact.

CREATE TABLE IF NOT EXISTS decision_log (
  id                BIGSERIAL PRIMARY KEY,
  sku_id            BIGINT NOT NULL REFERENCES skus(id) ON DELETE CASCADE,
  decided_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- what the engine actually recommended, and on what arithmetic
  action            TEXT NOT NULL,
  urgency           NUMERIC(5,3),
  value_aud         NUMERIC(12,2),
  best_net_aud      NUMERIC(12,2),
  method            TEXT,
  n_comps           INTEGER,
  confidence        NUMERIC(5,3),

  -- the descriptive scores, along for the ride and influencing nothing
  rarity_score      NUMERIC(5,1),
  condition_score   NUMERIC(5,1),
  market_score      NUMERIC(5,1),
  rarity_tier       TEXT,
  -- Version the heuristic explicitly. Weights that change whenever three sales land are
  -- worse than imperfect weights left alone, and without a version stamp you cannot
  -- tell which rows were produced by which guess.
  market_score_version TEXT NOT NULL DEFAULT 'heuristic-v1',
  calibrated        BOOLEAN NOT NULL DEFAULT FALSE,

  -- the timing decomposition, so a later analysis can test the split itself
  hype_share        NUMERIC(5,3),
  baseline_share    NUMERIC(5,3),
  half_life_days    INTEGER,
  retain_90         NUMERIC(5,3),

  -- observed later, by tools/observe-outcomes.ts
  median_price_at_decision NUMERIC(12,2),
  median_price_30d  NUMERIC(12,2),
  median_price_60d  NUMERIC(12,2),
  sales_next_30d    INTEGER,
  sales_next_60d    INTEGER,
  outcome_observed_at TIMESTAMPTZ
);

-- One row per SKU per day: re-running the recommender should not inflate the sample.
-- `decided_at::date` is not immutable (it depends on TimeZone), so Postgres refuses it
-- in an index expression. A generated column pins the timezone and is indexable.
ALTER TABLE decision_log ADD COLUMN IF NOT EXISTS decided_on DATE
  GENERATED ALWAYS AS ((decided_at AT TIME ZONE 'UTC')::date) STORED;
CREATE UNIQUE INDEX IF NOT EXISTS decision_log_daily
  ON decision_log (sku_id, decided_on);
CREATE INDEX IF NOT EXISTS decision_log_time ON decision_log (decided_at);

-- ---------------------------------------------------------------------------
-- PSA population: context, NOT condition
-- ---------------------------------------------------------------------------
--
-- A PSA 10 is condition. A PSA 10 out of 40 graded is a different card from a PSA 10 out
-- of 4,000 — but that is *population context*, a separate axis, and it must not be
-- folded into the condition score. Kept in its own table for the same reason.
--
-- And low population does not mean rare. It can mean unpopular, or new, or not worth
-- grading, or that owners prefer BGS. So nothing here applies a value bonus on its own.

CREATE TABLE IF NOT EXISTS psa_population (
  sku_id            BIGINT PRIMARY KEY REFERENCES skus(id) ON DELETE CASCADE,
  psa_spec_id       BIGINT,
  population_total  INTEGER,
  population_grade  INTEGER,   -- count at this SKU's own grade
  population_higher INTEGER,   -- count above it
  gem_rate          NUMERIC(6,4),  -- grade-10 count / total graded
  by_grade          JSONB,     -- the full distribution as returned
  source            TEXT,      -- 'psa_api' | 'manual'
  checked_at        TIMESTAMPTZ,
  note              TEXT
);

COMMENT ON TABLE psa_population IS
  'Grade-scarcity context. Never an input to condition_score, and never a value bonus '
  'on its own: a low population can mean rare, unpopular, new, or simply not worth '
  'grading, and only market evidence distinguishes those.';

-- ###########################################################################
-- #  012_geo_and_local.sql
-- ###########################################################################

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

-- ###########################################################################
-- #  013_accounts.sql
-- ###########################################################################

-- CardVault :: accounts, and the end of "there is only one of me"
--
-- Everything here exists to answer one question that the schema previously could not ask:
-- WHOSE card is this. Until now `holdings` had `UNIQUE (sku_id)` — one row per SKU for the
-- whole database — which is not merely a missing feature, it is an assertion that two people
-- cannot own the same card. Two friends both holding Mora #214 was unrepresentable.
--
-- The other thing it could not do is keep a secret. The `portfolio` view has no WHERE clause
-- at all, and `/api/overview`, `/api/portfolio` and the player pages read straight from it, so
-- the moment a second person existed every total on the dashboard would silently be the sum of
-- everybody's collection, cost basis included.
--
-- Four parts:
--   1. `users` and `sessions`
--   2. `user_id` on the three owned tables, backfilled to a bootstrap owner
--   3. the unique constraint swap, which is what actually unblocks sharing a checklist
--   4. `portfolio` carrying `user_id`, plus `my_*` views for the AI path

-- ---------------------------------------------------------------------------
-- 1. Accounts
-- ---------------------------------------------------------------------------
--
-- Password verification lives in the application (scrypt, from Node's stdlib — no new
-- dependency, and a memory-hard KDF rather than a bare hash). The database stores an opaque
-- string and never interprets it; `pass_algo` is recorded so a future rehash can tell what it
-- is looking at instead of guessing.
--
-- `username` is stored as typed but compared case-insensitively via the functional unique
-- index: "Felix" and "felix" must not become two accounts, because the person typing the
-- second one will believe they are logging into the first.

CREATE TABLE IF NOT EXISTS users (
  id            BIGSERIAL PRIMARY KEY,
  username      TEXT NOT NULL,
  display_name  TEXT,
  pass_hash     TEXT NOT NULL,
  pass_algo     TEXT NOT NULL DEFAULT 'scrypt-1',
  -- 'owner' can create and disable accounts. Everyone else is 'member'. Deliberately not a
  -- permission bitfield: two roles is the honest description of a tool for a few friends.
  role          TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'member')),
  active        BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS users_username_key ON users (lower(username));

COMMENT ON TABLE users IS
  'One row per person. Deleting a user is deliberately not supported: their holdings and '
  'sales reference them, and losing sales history to tidy up an account is a worse outcome '
  'than an inactive row. Set active = FALSE instead.';

-- Opaque random tokens rather than JWTs. A JWT cannot be revoked without keeping a
-- server-side list of the ones you have revoked — at which point you have a sessions table
-- with extra steps. Logging out of a phone you left somewhere has to actually work.
--
-- Only the SHA-256 of the token is stored. If someone reads this table they still cannot log
-- in as anybody, which matters because the whole point of the next phase is exposing this to
-- the internet.
CREATE TABLE IF NOT EXISTS sessions (
  token_hash  TEXT PRIMARY KEY,
  user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL,
  user_agent  TEXT
);

CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions (user_id);
CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions (expires_at);

-- ---------------------------------------------------------------------------
-- 2. The bootstrap owner, and backfilling what already exists
-- ---------------------------------------------------------------------------
--
-- There is already a collection in this database and it belongs to somebody. Creating the
-- owner row here, rather than making `user_id` nullable and sorting it out later, is what
-- keeps the constraint in part 3 honest: a nullable owner column means "unowned" is
-- representable, and unowned rows are exactly what leaks.
--
-- The password hash is a deliberately invalid placeholder. `npm run user -- --set-password`
-- sets a real one; until then the account cannot be logged into, which is better than a
-- default password that ships in a repo and is still there in a year.

INSERT INTO users (username, display_name, pass_hash, pass_algo, role)
SELECT 'owner', 'Owner', 'x', 'unset', 'owner'
WHERE NOT EXISTS (SELECT 1 FROM users);

ALTER TABLE holdings  ADD COLUMN IF NOT EXISTS user_id BIGINT REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE sales     ADD COLUMN IF NOT EXISTS user_id BIGINT REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE watchlist ADD COLUMN IF NOT EXISTS user_id BIGINT REFERENCES users(id) ON DELETE CASCADE;

-- Existing rows predate accounts, so they belong to whoever the owner is.
UPDATE holdings  SET user_id = (SELECT id FROM users WHERE role = 'owner' ORDER BY id LIMIT 1) WHERE user_id IS NULL;
UPDATE sales     SET user_id = (SELECT id FROM users WHERE role = 'owner' ORDER BY id LIMIT 1) WHERE user_id IS NULL;
UPDATE watchlist SET user_id = (SELECT id FROM users WHERE role = 'owner' ORDER BY id LIMIT 1) WHERE user_id IS NULL;

ALTER TABLE holdings  ALTER COLUMN user_id SET NOT NULL;
ALTER TABLE sales     ALTER COLUMN user_id SET NOT NULL;
-- watchlist stays nullable: a NULL there means a system-wide watch, not an unowned holding.

-- Every user-scoped read filters on user_id first, so it leads every index.
CREATE INDEX IF NOT EXISTS holdings_user_idx  ON holdings (user_id);
CREATE INDEX IF NOT EXISTS sales_user_time_idx ON sales (user_id, sold_at DESC);
CREATE INDEX IF NOT EXISTS watchlist_user_idx ON watchlist (user_id);

-- ---------------------------------------------------------------------------
-- 3. The constraint swap
-- ---------------------------------------------------------------------------
--
-- This is the change that actually makes sharing possible, and it has to be done in this
-- order: add the new constraint before dropping the old one would fail, and dropping the old
-- one before adding the new one leaves a window with no uniqueness at all. Postgres is
-- transactional per migration file, so both land together or neither does.
--
-- Note what the new key means for every writer: `ON CONFLICT (sku_id)` must become
-- `ON CONFLICT (user_id, sku_id)`. Left alone, the qty-increment upserts would add one
-- person's quantity onto another person's row.

ALTER TABLE holdings DROP CONSTRAINT IF EXISTS holdings_sku_id_key;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'holdings_user_sku_key'
  ) THEN
    ALTER TABLE holdings ADD CONSTRAINT holdings_user_sku_key UNIQUE (user_id, sku_id);
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 4. Views: carry the owner, and give the AI path something it cannot escape
-- ---------------------------------------------------------------------------
--
-- `portfolio` gains `user_id` and `owner_name`. It is still unfiltered — that is correct for
-- a view — but every consumer now has something to filter on, and a query that forgets is a
-- query that returns a `user_id` column it is not using, which is at least visible.

DROP VIEW IF EXISTS portfolio;
CREATE VIEW portfolio AS
SELECT h.id            AS holding_id,
       h.user_id,
       u.username      AS owner_name,
       u.display_name  AS owner_display_name,
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
JOIN users u ON u.id = h.user_id
JOIN sku_detail d ON d.sku_id = h.sku_id
LEFT JOIN product_boxes b ON b.id = h.box_id
LEFT JOIN latest_valuation v ON v.sku_id = h.sku_id AND v.marketplace_code IS NULL
LEFT JOIN latest_recommendation r ON r.sku_id = h.sku_id;

COMMENT ON VIEW portfolio IS
  'Every holding, every user. ALWAYS filter on user_id. /api/overview and /api/portfolio '
  'read this and would otherwise report the sum of everybody''s collection as yours.';

-- The natural-language query path is a different problem, because the SQL text is written by
-- a model and cannot be audited in advance. Its only defence is a whitelist of readable
-- relations — which stops it reading `pg_authid`, and does nothing whatsoever about tenancy.
-- A generated `SELECT SUM(total_value_aud) FROM portfolio` is a perfectly valid query that
-- reads everyone.
--
-- So the owned tables come off that whitelist and these go on instead. They filter on a
-- session GUC that the application sets inside the same read-only transaction, which means
-- the model cannot widen the scope no matter what it writes: there is no syntax for "and also
-- the other users", because the rows are gone before its query starts.
--
-- `current_setting(..., true)` returns NULL when unset, and `user_id = NULL` matches nothing.
-- Failing closed is the whole design: forget to set the GUC and the answer is empty, never
-- everybody.

CREATE OR REPLACE VIEW my_holdings AS
  SELECT h.* FROM holdings h
   WHERE h.user_id = NULLIF(current_setting('cardvault.user_id', true), '')::bigint;

CREATE OR REPLACE VIEW my_sales AS
  SELECT s.* FROM sales s
   WHERE s.user_id = NULLIF(current_setting('cardvault.user_id', true), '')::bigint;

CREATE OR REPLACE VIEW my_portfolio AS
  SELECT p.* FROM portfolio p
   WHERE p.user_id = NULLIF(current_setting('cardvault.user_id', true), '')::bigint;

CREATE OR REPLACE VIEW my_watchlist AS
  SELECT w.* FROM watchlist w
   WHERE w.user_id = NULLIF(current_setting('cardvault.user_id', true), '')::bigint;

COMMENT ON VIEW my_portfolio IS
  'Scoped to the session GUC cardvault.user_id. Fails closed: unset GUC returns no rows. '
  'This is what the AI query path is allowed to read instead of portfolio.';

-- ---------------------------------------------------------------------------
-- 5. Alerts belong to a person too
-- ---------------------------------------------------------------------------
--
-- Every alert rule starts from "a card you hold", so an alert without an owner is an alert
-- delivered to everybody about somebody else's card. `user_id` is nullable because an alert
-- about the system itself (a source failing, say) legitimately has no owner, and forcing a
-- fake one would make "whose is this" unanswerable.
--
-- The dedupe probes in `runAlerts` must include user_id: otherwise the first person to be told
-- their Mora moved suppresses the alert for everyone else who holds it.

ALTER TABLE alerts ADD COLUMN IF NOT EXISTS user_id BIGINT REFERENCES users(id) ON DELETE CASCADE;

UPDATE alerts SET user_id = (SELECT id FROM users WHERE role = 'owner' ORDER BY id LIMIT 1)
 WHERE user_id IS NULL AND sku_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS alerts_user_idx ON alerts (user_id, fired_at DESC);

-- ###########################################################################
-- #  014_products_cde.sql
-- ###########################################################################

-- CardVault :: three more products
--
--   C  2025-26 Panini Prizm FIFA                (club format, 300-card base)
--   D  2025-26 Panini Select Road to FIFA WC 26 (250-card base, three tiers)
--   E  2025-26 Topps Chrome UEFA Club Competitions (200-card base)
--
-- ---------------------------------------------------------------------------
-- WHAT THIS FILE DOES AND DOES NOT CONTAIN — read this before wondering why
-- ---------------------------------------------------------------------------
--
-- It contains the **products and their parallel ladders**, taken from published set
-- information and recorded with sources.
--
-- It contains **no base cards** — but that no longer means there are none. When this file was
-- written I had no verifiable checklist for these three, and inventing 750 player-and-number
-- rows would have been worse than useless: a card number attached to the wrong player is
-- permanent, silently mismatches every future comp for that card, and looks exactly like real
-- data. The published checklists were found shortly afterwards and all 750 base cards now ship
-- in `db/seeds/cards.json` (Prizm 1-300, Select 1-250 across its three tiers, Topps Chrome
-- 1-200), loaded by `npm run seed` rather than by a migration, which is where every other base
-- card in this app lives too.
--
-- The parallels stay here because they are the half a seed file cannot carry. Print run drives
-- the rarity ladder, the scarcity exposure in the decay model and the fallback pricing
-- multiplier, and it is the part a collector cannot reconstruct from the card in their hand —
-- a Prizm "Pink Power" says nothing about /75 on the front.
--
-- Sources (fetched 2026-08-08):
--   Prizm  https://www.checklistinsider.com/2025-26-panini-prizm-fifa-soccer
--          https://www.cardboardconnection.com/2025-26-panini-prizm-fifa-set-review-and-checklist
--   Select https://www.checklistinsider.com/2025-26-panini-select-road-to-fifa-world-cup
--   Topps  https://www.checklistinsider.com/2025-26-topps-chrome-uefa
--
-- Where a source was vague ("numbered parallels range from /299 down to /5"), the vague ones
-- are OMITTED rather than guessed. A missing parallel is added the moment you type it; an
-- invented one with a wrong print run quietly mis-prices a card forever.

INSERT INTO products (code, name, manufacturer, season, release_date, notes) VALUES
  ('C', 'Panini Prizm FIFA 25/26', 'Panini', '2025-26', '2026-05-01',
   'Club format, 300-card base across 26 clubs. Cards are listed by CLUB, not by country, so '
   || 'their team is left empty and the club is recorded in the notes.'),
  ('D', 'Panini Select Road to WC 26', 'Panini', '2025-26', '2026-03-01',
   '250-card base in three tiers - Terrace 1-100, Mezzanine 101-200, Field Level 201-250. '
   || 'Field Level is the rarest and is printed horizontally.'),
  ('E', 'Topps Chrome UEFA Club 25/26', 'Topps', '2025-26', '2026-05-07',
   '200-card base plus 15 short-printed Radiating Rookies. UEFA club competitions, not a '
   || 'World Cup product.')
ON CONFLICT (code) DO UPDATE SET
  name = EXCLUDED.name, manufacturer = EXCLUDED.manufacturer,
  season = EXCLUDED.season, notes = EXCLUDED.notes;

-- ---------------------------------------------------------------------------
-- C — Panini Prizm FIFA 25/26
-- ---------------------------------------------------------------------------
--
-- Only the parallels with a stated print run are entered as numbered. The unnumbered ones
-- (Silver, Hyper, Lazer, Wave, Mosaic, Snakeskin, Soccer Ball, Genesis, Pulsar and the Choice
-- family) are entered too, with a NULL print run, because "unnumbered parallel" is a real and
-- distinct thing from "base" in both the rarity ladder and in what a buyer will pay.

INSERT INTO parallels (product_code, section, name, print_run) VALUES
  -- numbered, rarest last
  ('C','Base','Orange Mosaic (#/299)',299),
  ('C','Base','Blue Mosaic (#/209)',209),
  ('C','Base','Blue (#/199)',199),
  ('C','Base','Red (#/149)',149),
  ('C','Base','Purple Mosaic (#/135)',135),
  ('C','Base','Orange (#/125)',125),
  ('C','Base','Red Pulsar (#/99)',99),
  ('C','Base','Teal Ice (#/99)',99),
  ('C','Base','Choice Red (#/88)',88),
  ('C','Base','Pink Power (#/75)',75),
  ('C','Base','Blue Pulsar (#/65)',65),
  ('C','Base','Purple Wave (#/49)',49),
  ('C','Base','Choice Snake Year (#/48)',48),
  ('C','Base','Choice Cherry Blossom (#/28)',28),
  ('C','Base','Pink Pulsar (#/25)',25),
  ('C','Base','White Lazer (#/25)',25),
  ('C','Base','Choice Lotus Flower (#/18)',18),
  ('C','Base','Pink Mojo (#/11)',11),
  ('C','Base','Gold (#/10)',10),
  ('C','Base','Gold Mosaic (#/10)',10),
  ('C','Base','Gold Pulsar (#/10)',10),
  ('C','Base','Choice Gold (#/10)',10),
  ('C','Base','Choice Plum Blossom (#/8)',8),
  ('C','Base','Blue Shimmer (#/5)',5),
  ('C','Base','Choice Green (#/5)',5),
  ('C','Base','Green (#/5)',5),
  ('C','Base','Gold Shimmer (#/3)',3),
  ('C','Base','Green Shimmer (#/2)',2),
  ('C','Base','Black (1/1)',1),
  ('C','Base','Black Finite (1/1)',1),
  ('C','Base','Black Pulsar (1/1)',1),
  ('C','Base','Black Shimmer (1/1)',1),
  ('C','Base','Choice Nebula (1/1)',1),
  -- unnumbered
  ('C','Base','Silver',NULL),
  ('C','Base','Hyper',NULL),
  ('C','Base','Lazer',NULL),
  ('C','Base','Wave',NULL),
  ('C','Base','Mosaic',NULL),
  ('C','Base','Pink Mosaic',NULL),
  ('C','Base','Red Mosaic',NULL),
  ('C','Base','Pulsar',NULL),
  ('C','Base','Genesis',NULL),
  ('C','Base','Snakeskin',NULL),
  ('C','Base','Soccer Ball',NULL),
  ('C','Base','Green Ice',NULL),
  ('C','Base','White Sparkle',NULL),
  ('C','Base','Red & White Checker',NULL),
  ('C','Base','Choice',NULL),
  ('C','Base','Choice Green & White',NULL),
  ('C','Base','Choice Multi-Color',NULL),
  ('C','Base','Choice Red & Gold',NULL)
ON CONFLICT (product_code, section, name) DO UPDATE SET print_run = EXCLUDED.print_run;

-- ---------------------------------------------------------------------------
-- D — Panini Select Road to World Cup 26
-- ---------------------------------------------------------------------------
--
-- Select's base is three tiers, and they are genuinely different cards rather than parallels:
-- Terrace, Mezzanine and Field Level have their own card numbers and their own scarcity. They
-- are therefore modelled as SECTIONS, and each carries the same parallel ladder.
--
-- The source described the ladder as running "/825 down to 1/1" without naming every rung, so
-- only the rungs it named explicitly are recorded. The rest arrive as you find them.

INSERT INTO parallels (product_code, section, name, print_run)
SELECT 'D', s.section, p.name, p.print_run
  FROM (VALUES ('Base Terrace'),('Base Mezzanine'),('Base Field Level')) AS s(section)
 CROSS JOIN (VALUES
   ('Orange Mojo (#/825)',825),
   ('Panini Logo (#/61)',61),
   ('Gold (#/10)',10),
   ('Neon Purple Pulsar (#/3)',3),
   ('Black (1/1)',1),
   ('Black Dragon Scale (1/1)',1),
   ('Black Ice (1/1)',1),
   ('Black Mojo (1/1)',1),
   ('Black Snakeskin Pulsar (1/1)',1),
   ('Silver',NULL),
   ('Ice',NULL),
   ('Red Ice',NULL),
   ('Green Ice',NULL),
   ('Pink Ice',NULL),
   ('Flash',NULL),
   ('Red & Green Flash',NULL),
   ('Checkerboard',NULL),
   ('Blue Checker',NULL),
   ('Honeycomb',NULL),
   ('Multi-Color',NULL),
   ('Peacock',NULL),
   ('Purple Mojo',NULL),
   ('Red Pandora',NULL),
   ('White Sparkle',NULL)
 ) AS p(name, print_run)
ON CONFLICT (product_code, section, name) DO UPDATE SET print_run = EXCLUDED.print_run;

-- ---------------------------------------------------------------------------
-- E — Topps Chrome UEFA Club Competitions 25/26
-- ---------------------------------------------------------------------------
--
-- Topps names its parallels "refractors", and the ladder published for this set is only
-- partially specified ("/299 down to /5"). Three rungs were named with numbers and are recorded;
-- the unnumbered and format-exclusive ones are recorded without a run.

INSERT INTO parallels (product_code, section, name, print_run) VALUES
  ('E','Base','Teal Refractor (#/299)',299),
  ('E','Base','Black Refractor (#/10)',10),
  ('E','Base','Red Refractor (#/5)',5),
  ('E','Base','SuperFractor (1/1)',1),
  ('E','Base','Refractor',NULL),
  ('E','Base','X-Fractor',NULL),
  ('E','Base','Mini-Diamond Refractor',NULL),
  ('E','Base','RayWave Refractor',NULL),
  ('E','Base','FrozenFractor',NULL)
ON CONFLICT (product_code, section, name) DO UPDATE SET print_run = EXCLUDED.print_run;

COMMENT ON TABLE products IS
  'All five products carry a full seeded base checklist (db/seeds/cards.json). Parallel '
  'ladders live in migrations. Anything a checklist does not list is created on demand as '
  'you record it - never guessed, because an invented card number corrupts matching '
  'permanently.';

-- ###########################################################################
-- #  015_card_photos.sql
-- ###########################################################################

-- CardVault :: photographs of the cards you actually own
--
-- ---------------------------------------------------------------------------
-- WHY THIS IS NOT JUST ANOTHER COLUMN ON `skus`
-- ---------------------------------------------------------------------------
--
-- There is already a picture attached to every SKU (`skus.image_path`, added in 003). It is
-- one picture, shared by the whole database, and it was correct while the whole database was
-- one person. It is not correct now.
--
-- A SKU is "Lamine Yamal Prizm #245 Pink Power, raw". Two friends can both own one. Under the
-- old scheme the second of them to upload a photo REPLACES the first — silently, with no
-- error, and the delete-the-old-file line in `saveOwnPhoto` means the first photo is gone off
-- the disk as well. That is not a shared library, it is a race.
--
-- It also loses the thing the photo is FOR. The reason you photograph a card you own is that
-- the card in your hand has particular corners, particular centering, a particular flick of
-- surface wear — and those are exactly what a buyer is paying for and exactly what differs
-- between your copy and your friend's. A picture that stands for "what this card looks like
-- in general" already exists and is harvested automatically from sold listings. This table is
-- for the other thing.
--
-- ---------------------------------------------------------------------------
-- WHY (user_id, sku_id) AND NOT holding_id
-- ---------------------------------------------------------------------------
--
-- The obvious key is the holding — your physical copy is a holding row, so hang the photo off
-- it. It is the wrong key, for one reason: selling the card deletes the holding.
--
-- `holdings` is your CURRENT stock. When a card sells the row goes away and a `sales` row
-- appears. A foreign key to `holdings` with ON DELETE CASCADE would therefore destroy the
-- photographs at the exact moment they become most useful — a dispute over what was posted,
-- a return, a buyer asking to see the back again, your own record of what left the house.
-- Deliberately not cascading is worse: you get rows pointing at a holding that no longer
-- exists and no way to tell whether that means "sold" or "corrupt".
--
-- `holdings` is already UNIQUE (user_id, sku_id), so keying on the same pair is one-to-one
-- with the holding for as long as the holding exists, and outlives it afterwards. The photo
-- means "my copy of this card", which is true before the sale and still true after it.
--
-- The honest cost of this choice: if you own TWO copies of the same SKU (qty = 2), they share
-- one pair of photographs. Splitting them would mean giving every individual card its own
-- identity, which is a much larger change and buys nothing until you are grading duplicates
-- separately. Recorded here so the limit is a decision rather than a surprise.
--
-- ---------------------------------------------------------------------------
-- WHY THE PATH IS RELATIVE
-- ---------------------------------------------------------------------------
--
-- `rel_path` is relative to the photo root and never absolute. Two consequences, both wanted:
--
--   * The root can move. It is a bind mount on a Windows PC today; if it becomes a different
--     drive letter, an external disk or a NAS, no rows need rewriting.
--   * A path out of the database cannot escape the root. Absolute paths stored in a database
--     and later joined onto a filesystem are how `../../etc/passwd` gets served. The
--     application resolves and re-checks containment anyway, but the schema should not be
--     handing it a loaded gun in the first place.

CREATE TABLE IF NOT EXISTS card_photos (
  id          BIGSERIAL PRIMARY KEY,
  user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sku_id      BIGINT NOT NULL REFERENCES skus(id)  ON DELETE CASCADE,

  -- Front and back are separate rows rather than two columns, so that adding a third slot
  -- later (a corner close-up, a slab label) is a CHECK change and not a migration of every
  -- query that reads the table.
  side        TEXT NOT NULL CHECK (side IN ('front', 'back')),

  rel_path    TEXT NOT NULL,
  sha256      TEXT NOT NULL,
  bytes       INTEGER NOT NULL CHECK (bytes > 0),
  mime        TEXT NOT NULL,
  width       INTEGER,
  height      INTEGER,

  -- Whether the auto-cropper trimmed this, or the person kept the whole photo. Worth keeping:
  -- when a crop turns out to have eaten a corner, this is how you find every photo that went
  -- through the same code path.
  cropped     BOOLEAN NOT NULL DEFAULT FALSE,

  captured_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- One front and one back per person per card. Re-shooting replaces the row (and the file)
  -- rather than accumulating, which is what "take another go at that photo" should mean.
  UNIQUE (user_id, sku_id, side)
);

CREATE INDEX IF NOT EXISTS card_photos_sku_idx  ON card_photos (sku_id);
CREATE INDEX IF NOT EXISTS card_photos_user_idx ON card_photos (user_id);
-- Finding the duplicate of a file you already stored, so re-uploading the same shot does not
-- write it twice.
CREATE INDEX IF NOT EXISTS card_photos_sha_idx  ON card_photos (user_id, sha256);

COMMENT ON TABLE card_photos IS
  'Photographs of the physical card a specific person owns. Keyed (user_id, sku_id, side) so '
  'two people holding the same card keep separate photographs and neither can overwrite the '
  'other. Survives the sale of the card on purpose - see the header of 015_card_photos.sql.';

COMMENT ON COLUMN card_photos.rel_path IS
  'Path relative to the photo root, never absolute, so the root can move and so a stored '
  'path cannot escape it.';

-- ---------------------------------------------------------------------------
-- Reading them back
-- ---------------------------------------------------------------------------
--
-- Photographs are READABLE by everyone, unlike holdings and cost basis. That is the sharing
-- model already chosen for this app - see everything, edit only your own - and it is the
-- point of the feature: the reason to look at a friend's card is to help them work out what
-- it is and what it is worth.
--
-- Writing is restricted to the owner, and that check lives in the application rather than
-- here, because it needs the authenticated principal rather than a database role.

CREATE OR REPLACE VIEW card_photo_index AS
SELECT p.id,
       p.sku_id,
       p.side,
       p.rel_path,
       p.bytes,
       p.mime,
       p.width,
       p.height,
       p.cropped,
       p.captured_at,
       p.user_id,
       u.username,
       COALESCE(u.display_name, u.username) AS owner_name,
       s.label                              AS sku_label,
       s.card_id
  FROM card_photos p
  JOIN users u ON u.id = p.user_id
  JOIN skus  s ON s.id = p.sku_id;

COMMENT ON VIEW card_photo_index IS
  'Every photograph with who took it and what it is of. Intentionally unscoped: photographs '
  'are shared, cost basis is not.';

-- The GUC-scoped twin, for the AI/SQL path which must never see another person''s rows even
-- when the rows in question are harmless. Consistency there is worth more than the extra
-- view: a whitelist with an exception in it is a whitelist nobody can reason about.
CREATE OR REPLACE VIEW my_card_photos AS
SELECT * FROM card_photo_index
 WHERE user_id = NULLIF(current_setting('cardvault.user_id', true), '')::bigint;

COMMENT ON VIEW my_card_photos IS
  'Scoped to the session GUC cardvault.user_id. Fails closed: unset GUC returns no rows.';

COMMIT;
