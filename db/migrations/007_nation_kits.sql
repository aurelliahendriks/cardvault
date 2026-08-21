-- CardVault :: national kit colours
--
-- Gives every player a distinct picture immediately, with no AI and no rights
-- problem: the avatar silhouette sits on their nation's kit colours and pattern.
-- Argentina reads as sky-blue stripes, Croatia as red checks, the Netherlands as
-- orange — 56 nations, instantly told apart in a grid.
--
-- `verified` marks the ones I'm confident about. Anything false is a best guess and
-- may be wrong; anything absent falls back to a neutral tint derived from the name
-- rather than asserting a colour. Correct any of it with SQL — see docs/PLAYER-ART.md.

CREATE TABLE IF NOT EXISTS nation_kits (
  team            TEXT PRIMARY KEY,
  primary_hex     TEXT NOT NULL,
  secondary_hex   TEXT NOT NULL,
  -- 'solid' | 'stripes' | 'checks' | 'halves'
  pattern         TEXT NOT NULL DEFAULT 'solid',
  verified        BOOLEAN NOT NULL DEFAULT FALSE,
  note            TEXT
);

INSERT INTO nation_kits (team, primary_hex, secondary_hex, pattern, verified, note) VALUES
  -- Instantly recognisable home kits.
  ('Argentina',        '#75AADB', '#FFFFFF', 'stripes', TRUE,  'Sky blue and white vertical stripes.'),
  ('Brazil',           '#FFDF00', '#009739', 'solid',   TRUE,  'Canary yellow, green trim.'),
  ('Netherlands',      '#FF6200', '#FFFFFF', 'solid',   TRUE,  'Oranje.'),
  ('Croatia',          '#FF0000', '#FFFFFF', 'checks',  TRUE,  'Red and white chequerboard.'),
  ('Italy',            '#0066B2', '#FFFFFF', 'solid',   TRUE,  'Azzurri.'),
  ('France',           '#001E62', '#FFFFFF', 'solid',   TRUE,  'Les Bleus.'),
  ('Germany',          '#FFFFFF', '#111111', 'solid',   TRUE,  'White with black.'),
  ('England',          '#FFFFFF', '#001E62', 'solid',   TRUE,  'White with navy.'),
  ('Spain',            '#C60B1E', '#FFD700', 'solid',   TRUE,  'La Roja.'),
  ('Portugal',         '#8B0000', '#006600', 'solid',   TRUE,  'Dark red with green.'),
  ('Uruguay',          '#5CBFEB', '#000000', 'solid',   TRUE,  'Celeste.'),
  ('Mexico',           '#006847', '#FFFFFF', 'solid',   TRUE,  'Green.'),
  ('United States',    '#FFFFFF', '#0A3161', 'solid',   TRUE,  'White with navy.'),
  ('Canada',           '#D52B1E', '#FFFFFF', 'solid',   TRUE,  'Red.'),
  ('Japan',            '#1B2F7A', '#FFFFFF', 'solid',   TRUE,  'Samurai Blue.'),
  ('Korea Republic',   '#CD2E3A', '#FFFFFF', 'solid',   TRUE,  'Red.'),
  ('Belgium',          '#E30613', '#000000', 'solid',   TRUE,  'Red Devils.'),
  ('Sweden',           '#FECB00', '#005293', 'solid',   TRUE,  'Yellow with blue.'),
  ('Norway',           '#BA0C2F', '#FFFFFF', 'solid',   TRUE,  'Red.'),
  ('Switzerland',      '#D52B1E', '#FFFFFF', 'solid',   TRUE,  'Red with white cross.'),
  ('Poland',           '#FFFFFF', '#DC143C', 'solid',   TRUE,  'White with red.'),
  ('Morocco',          '#C1272D', '#006233', 'solid',   TRUE,  'Red with green.'),
  ('Senegal',          '#FFFFFF', '#00853F', 'solid',   TRUE,  'White with green.'),
  ('Nigeria',          '#008751', '#FFFFFF', 'solid',   TRUE,  'Super Eagles green.'),
  ('Colombia',         '#FCD116', '#003893', 'solid',   TRUE,  'Yellow with blue.'),
  ('Paraguay',         '#D52B1E', '#FFFFFF', 'stripes', TRUE,  'Red and white stripes.'),
  ('Cymru',            '#C8102E', '#FFFFFF', 'solid',   TRUE,  'Wales — red.'),
  ('Scotland',         '#1B3A6B', '#FFFFFF', 'solid',   TRUE,  'Dark blue.'),
  ('Republic of Ireland','#169B62','#FFFFFF','solid',   TRUE,  'Green.'),
  ('Northern Ireland', '#00843D', '#FFFFFF', 'solid',   TRUE,  'Green.'),
  ('Australia',        '#FFCD00', '#00843D', 'solid',   TRUE,  'Socceroos gold.'),
  ('Qatar',            '#8A1538', '#FFFFFF', 'solid',   TRUE,  'Maroon.'),
  ('Saudi Arabia',     '#FFFFFF', '#006C35', 'solid',   TRUE,  'White with green.'),
  ('Serbia',           '#C6363C', '#0C4076', 'solid',   TRUE,  'Red with blue.'),
  ('Türkiye',          '#E30A17', '#FFFFFF', 'solid',   TRUE,  'Red.'),
  ('Egypt',            '#CE1126', '#FFFFFF', 'solid',   TRUE,  'Red.'),
  ('Ghana',            '#FFFFFF', '#CE1126', 'solid',   TRUE,  'White with red.'),
  ('Ecuador',          '#FFD100', '#003893', 'solid',   TRUE,  'Yellow with blue.'),
  ('Austria',          '#ED2939', '#FFFFFF', 'solid',   TRUE,  'Red.'),
  ('Czechia',          '#D7141A', '#FFFFFF', 'solid',   TRUE,  'Red.'),
  ('Ivory Coast',      '#F77F00', '#FFFFFF', 'solid',   TRUE,  'Orange.'),
  ('Algeria',          '#FFFFFF', '#007A3D', 'solid',   TRUE,  'White with green.'),
  ('Tunisia',          '#E70013', '#FFFFFF', 'solid',   TRUE,  'Red.'),
  ('Iran',             '#FFFFFF', '#239F40', 'solid',   TRUE,  'White with green.'),
  ('New Zealand',      '#FFFFFF', '#111111', 'solid',   TRUE,  'All Whites.'),
  ('South Africa',     '#FFB612', '#007A4D', 'solid',   TRUE,  'Bafana Bafana yellow.'),

  -- Less certain; shown but flagged so you can correct them.
  ('Bosnia and Herzegovina','#002F6C','#FFD100','solid', FALSE, 'Blue with yellow — verify.'),
  ('Iraq',             '#007A3D', '#FFFFFF', 'solid',   FALSE, 'Green — verify.'),
  ('Honduras',         '#FFFFFF', '#0073CF', 'solid',   FALSE, 'White with blue — verify.'),
  ('Cape Verde',       '#003893', '#FFFFFF', 'solid',   FALSE, 'Blue — verify.'),
  ('Congo DR',         '#007FFF', '#FFD100', 'solid',   FALSE, 'Blue — verify.'),
  ('Uzbekistan',       '#0099B5', '#FFFFFF', 'solid',   FALSE, 'Blue — verify.'),
  ('Curaçao',          '#002B7F', '#FFD100', 'solid',   FALSE, 'Blue with yellow — verify.'),
  ('Jordan',           '#FFFFFF', '#CE1126', 'solid',   FALSE, 'White with red — verify.'),
  ('Haiti',            '#00209F', '#D21034', 'solid',   FALSE, 'Blue with red — verify.'),
  ('Panama',           '#DA121A', '#005293', 'solid',   FALSE, 'Red with blue — verify.')
ON CONFLICT (team) DO NOTHING;
