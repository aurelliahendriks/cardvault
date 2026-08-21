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
