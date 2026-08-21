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

CREATE TABLE products (
  code            TEXT PRIMARY KEY,              -- 'A', 'B'
  name            TEXT NOT NULL,                 -- 'Donruss Road to WC 25/26'
  manufacturer    TEXT,
  season          TEXT,
  release_date    DATE,
  notes           TEXT
);

CREATE TABLE cards (
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

CREATE INDEX cards_player_trgm  ON cards USING gin (player gin_trgm_ops);
CREATE INDEX cards_search_trgm  ON cards USING gin (search_text gin_trgm_ops);
CREATE INDEX cards_section_idx  ON cards (product_code, section);
CREATE INDEX cards_embedding_idx ON cards USING hnsw (embedding vector_cosine_ops);

-- Parallels are defined per (product, section); a NULL card_id means
-- "applies to every card in that section".
CREATE TABLE parallels (
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
CREATE INDEX parallels_name_trgm ON parallels USING gin (name gin_trgm_ops);

-- A SKU is the actual tradeable unit: card + parallel + grade.
CREATE TABLE skus (
  id              BIGSERIAL PRIMARY KEY,
  card_id         BIGINT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  parallel_id     BIGINT REFERENCES parallels(id) ON DELETE SET NULL,
  grader          TEXT,                          -- NULL = raw; 'PSA','BGS','SGC','CGC'
  grade           NUMERIC(3,1),                  -- 10, 9.5, 9 ...
  label           TEXT NOT NULL,                 -- denormalized human label
  created_at      TIMESTAMPTZ DEFAULT now(),
  UNIQUE (card_id, parallel_id, grader, grade)
);
CREATE INDEX skus_card_idx ON skus (card_id);
-- NULLS NOT DISTINCT keeps the unique constraint meaningful for raw/base SKUs
-- IF EXISTS because this statement runs a second time whenever the schema is applied as one
-- bundled file (db/cardvault.sql). Without it the constraint is already gone, the statement
-- errors, and - since the bundle is one transaction - EVERY later migration in the file is
-- rolled back. The failure mode is the nasty one: the file appears to run, the schema does
-- not change, and it looks like the bundle simply had nothing to do.
ALTER TABLE skus DROP CONSTRAINT IF EXISTS skus_card_id_parallel_id_grader_grade_key;
CREATE UNIQUE INDEX skus_identity ON skus (card_id, parallel_id, grader, grade) NULLS NOT DISTINCT;

-- ---------------------------------------------------------------------------
-- Marketplaces, fees, FX
-- ---------------------------------------------------------------------------

CREATE TABLE marketplaces (
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

CREATE TABLE fx_rates (
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

CREATE TABLE sources (
  code            TEXT PRIMARY KEY,              -- 'ebay_browse','ebay_insights','brightdata_ebay_sold', ...
  name            TEXT NOT NULL,
  kind            TEXT NOT NULL,                 -- 'api' | 'scrape' | 'manual'
  gives_sold      BOOLEAN NOT NULL,              -- true = realized sales, false = asks
  trust_weight    NUMERIC(4,2) NOT NULL DEFAULT 1.0,
  enabled         BOOLEAN DEFAULT TRUE,
  config          JSONB DEFAULT '{}'
);

CREATE TABLE source_runs (
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
CREATE INDEX source_runs_recent ON source_runs (source_code, started_at DESC);

CREATE TABLE listings (
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
CREATE INDEX listings_title_trgm ON listings USING gin (title gin_trgm_ops);
CREATE INDEX listings_sold_at    ON listings (sold_at DESC) WHERE is_sold;
CREATE INDEX listings_observed   ON listings (observed_at DESC);

-- One row per (listing -> SKU) resolution attempt.
CREATE TABLE comps (
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
CREATE INDEX comps_sku_time ON comps (sku_id, sold_at DESC) WHERE NOT excluded;
CREATE INDEX comps_mkt_time ON comps (marketplace_code, sold_at DESC) WHERE NOT excluded;

-- ---------------------------------------------------------------------------
-- Derived: valuations, velocity, recommendations
-- ---------------------------------------------------------------------------

CREATE TABLE valuations (
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
CREATE UNIQUE INDEX valuations_identity
  ON valuations (sku_id, marketplace_code, as_of, window_days) NULLS NOT DISTINCT;
CREATE INDEX valuations_latest ON valuations (sku_id, as_of DESC);

CREATE TABLE velocity (
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
CREATE UNIQUE INDEX velocity_identity
  ON velocity (sku_id, marketplace_code, as_of, window_days) NULLS NOT DISTINCT;

CREATE TABLE recommendations (
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
CREATE INDEX recommendations_latest ON recommendations (sku_id, as_of DESC);

-- ---------------------------------------------------------------------------
-- Where to sell: communities / channels
-- ---------------------------------------------------------------------------

CREATE TABLE communities (
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

CREATE TABLE holdings (
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

CREATE TABLE sales (
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
CREATE INDEX sales_time ON sales (sold_at DESC);

-- ---------------------------------------------------------------------------
-- Alerts + watchlist
-- ---------------------------------------------------------------------------

CREATE TABLE watchlist (
  id              BIGSERIAL PRIMARY KEY,
  sku_id          BIGINT REFERENCES skus(id) ON DELETE CASCADE,
  query           TEXT,                          -- free-text saved search
  rule            JSONB NOT NULL,                -- {type:'price_drop',pct:15} etc
  channel         TEXT DEFAULT 'log',            -- 'log','webhook','email'
  target          TEXT,
  last_fired_at   TIMESTAMPTZ,
  active          BOOLEAN DEFAULT TRUE
);

CREATE TABLE alerts (
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

CREATE TABLE ai_queries (
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

CREATE VIEW latest_valuation AS
SELECT DISTINCT ON (sku_id, marketplace_code)
       sku_id, marketplace_code, as_of, n_comps, fair_value_aud, median_aud,
       low_aud, high_aud, trend_30d_pct, trend_90d_pct, volatility, method, confidence
FROM valuations
ORDER BY sku_id, marketplace_code, as_of DESC;

CREATE VIEW latest_recommendation AS
SELECT DISTINCT ON (sku_id) *
FROM recommendations
ORDER BY sku_id, as_of DESC;

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
