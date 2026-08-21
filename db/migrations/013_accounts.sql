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
