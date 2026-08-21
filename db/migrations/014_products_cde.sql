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
