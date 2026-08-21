-- CardVault :: hand-checked clubs, correct as at July 2026
--
-- Same reasoning as positions.sql: name-matched, so it has to run after the cards are in.
--
-- Clubs are a SNAPSHOT. Panini prints the national side, not the employer, so this is the
-- one field the checklist cannot supply, and squads change every transfer window —
-- `club_source` and `club_checked_at` are how you judge whether to trust a row.

WITH seed(name, club) AS (VALUES
  ('Lionel Messi',        'Inter Miami'),
  ('Lamine Yamal',        'Barcelona'),
  ('Pedri',               'Barcelona'),
  ('Cristiano Ronaldo',   'Al Nassr'),
  ('Kylian Mbappe',       'Real Madrid'),
  ('Kylian Mbappé',       'Real Madrid'),
  ('Jude Bellingham',     'Real Madrid'),
  ('Rodrygo',             'Real Madrid'),
  ('Endrick',             'Real Madrid'),
  ('Thibaut Courtois',    'Real Madrid'),
  ('Erling Haaland',      'Manchester City'),
  ('Phil Foden',          'Manchester City'),
  ('Rodri',               'Manchester City'),
  ('Harry Kane',          'Bayern Munich'),
  ('Jamal Musiala',       'Bayern Munich'),
  ('Mohamed Salah',       'Liverpool'),
  ('Virgil van Dijk',     'Liverpool'),
  ('Alisson',             'Liverpool'),
  ('Alisson Becker',      'Liverpool'),
  ('Florian Wirtz',       'Liverpool'),
  ('Bukayo Saka',         'Arsenal'),
  ('Cristian Romero',     'Tottenham Hotspur'),
  ('Mohammed Kudus',      'Tottenham Hotspur'),
  ('Marquinhos',          'Paris Saint-Germain'),
  ('Achraf Hakimi',       'Paris Saint-Germain'),
  ('Gianluigi Donnarumma','Manchester City'),
  ('Victor Osimhen',      'Galatasaray'),
  ('Lautaro Martinez',    'Inter Milan'),
  ('Luka Modric',         'AC Milan'),
  ('Emiliano Martinez',   'Aston Villa'),
  ('Aaron Wan-Bissaka',   'West Ham United'),
  ('Takefusa Kubo',       'Real Sociedad'),
  ('Alvaro Morata',       'Como'),
  ('Neymar',              'Santos'),
  ('Neymar Jr',           'Santos'),
  ('Gilberto Mora',       'Club Tijuana'),
  ('Rodrigo De Paul',     'Inter Miami'),
  ('Rodrigo de Paul',     'Inter Miami')
)
UPDATE players p
   SET club = s.club, club_source = 'seed'
  FROM seed s
 WHERE p.name = s.name
   AND p.club IS NULL;
