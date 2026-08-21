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
