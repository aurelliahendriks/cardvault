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
