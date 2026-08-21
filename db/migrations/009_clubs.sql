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
