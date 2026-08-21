-- CardVault :: hand-checked playing positions
--
-- Lives in seeds rather than in the migration because it matches on player NAME, and on a
-- fresh install the migrations run before any cards exist — so every UPDATE was a no-op
-- and the player view came up empty. `npm run seed` runs this after the checklist loads,
-- and it is idempotent, so re-running costs nothing.
--
-- Deliberately short. An unknown position renders the neutral standing figure; a guessed
-- one looks like data. Dual-player checklist entries are left alone: one figure cannot
-- carry two positions.

WITH seed(name, position) AS (VALUES
  ('Lionel Messi',        'forward'),
  ('Cristiano Ronaldo',   'forward'),
  ('Kylian Mbappe',       'forward'),
  ('Kylian Mbappé',       'forward'),
  ('Erling Haaland',      'forward'),
  ('Harry Kane',          'forward'),
  ('Lautaro Martinez',    'forward'),
  ('Victor Osimhen',      'forward'),
  ('Endrick',             'forward'),
  ('Neymar',              'forward'),
  ('Neymar Jr',           'forward'),
  ('Alvaro Morata',       'forward'),
  ('Lamine Yamal',        'winger'),
  ('Bukayo Saka',         'winger'),
  ('Mohamed Salah',       'winger'),
  ('Mohammed Kudus',      'winger'),
  ('Rodrygo',             'winger'),
  ('Phil Foden',          'winger'),
  ('Takefusa Kubo',       'winger'),
  ('Jude Bellingham',     'midfielder'),
  ('Jamal Musiala',       'midfielder'),
  ('Pedri',               'midfielder'),
  ('Rodri',               'midfielder'),
  ('Luka Modric',         'midfielder'),
  ('Florian Wirtz',       'midfielder'),
  ('Gilberto Mora',       'midfielder'),
  ('Rodrigo De Paul',     'midfielder'),
  ('Rodrigo de Paul',     'midfielder'),
  ('Virgil van Dijk',     'centre-back'),
  ('Cristian Romero',     'centre-back'),
  ('Marquinhos',          'centre-back'),
  ('Achraf Hakimi',       'right-back'),
  ('Aaron Wan-Bissaka',   'right-back'),
  ('Alisson',             'goalkeeper'),
  ('Alisson Becker',      'goalkeeper'),
  ('Thibaut Courtois',    'goalkeeper'),
  ('Emiliano Martinez',   'goalkeeper'),
  ('Gianluigi Donnarumma','goalkeeper')
)
UPDATE players p
   SET position = s.position, position_source = 'seed'
  FROM seed s
 WHERE p.name = s.name
   AND p.position IS NULL;
