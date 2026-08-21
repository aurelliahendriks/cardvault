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
