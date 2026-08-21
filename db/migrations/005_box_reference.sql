-- CardVault :: box / pack configurations
--
-- `verified = TRUE` means the configuration was corroborated by product coverage.
-- `verified = FALSE` and `availability = 'reported_exclusive'` mean a source
-- claimed it and I could not confirm it elsewhere — the UI labels those as
-- reported rather than presenting them as fact. Correct any of it with SQL; see
-- docs/BOXES.md.

-- ---------------------------------------------------------------------------
-- A · Donruss Road to FIFA World Cup 25/26
-- Configurations per cardlines.com product review (packs/box, cards/pack, and
-- the per-box contents breakdown).
-- ---------------------------------------------------------------------------
INSERT INTO product_boxes
 (product_code, name, channel, packs_per_box, cards_per_pack, cards_per_box,
  guaranteed, contents_note, verified, source_url, sort_order)
VALUES
 ('A','Hobby','hobby',12,30,360,
  '1 autograph + 1 memorabilia card',
  'Per box: 6 numbered parallels, 12 Optic Holo parallels, 48 inserts or insert parallels.',
  TRUE,'https://cardlines.com/a-review-of-2025-26-panini-donruss-road-to-fifa-world-cup-soccer/',10),

 ('A','Hobby International','international',12,30,360,
  '1 autograph',
  'Per box: 3 numbered parallels, 12 Optic Argyle parallels, 48 inserts or insert parallels. Optic Argyle is only found in this configuration.',
  TRUE,'https://cardlines.com/a-review-of-2025-26-panini-donruss-road-to-fifa-world-cup-soccer/',20),

 ('A','Blaster','retail',6,15,90,
  '6 Rated Rookies',
  'Per box: 1 numbered parallel, 1 Optic Holo, 18 inserts or insert parallels. The cheapest way in, and the thinnest.',
  TRUE,'https://cardlines.com/a-review-of-2025-26-panini-donruss-road-to-fifa-world-cup-soccer/',30),

 ('A','Fat Pack','retail',12,25,300,
  '2 Rated Rookies',
  'Per box: 2 parallels, 3 Optic base or Rated Rookies, 3 inserts or insert parallels.',
  TRUE,'https://cardlines.com/a-review-of-2025-26-panini-donruss-road-to-fifa-world-cup-soccer/',40),

-- ---------------------------------------------------------------------------
-- B · Panini x Kayou FIFA World Cup 2026
-- ---------------------------------------------------------------------------
 ('B','Premium Hobby','hobby',10,6,60,
  NULL,
  '769 cards in the base checklist before parallels. Roughly 3-4 base and 2-3 inserts per pack.',
  TRUE,'https://www.rednails2.com/sports-cards-boxes/soccer-other/2026-panini-x-kayou-fifa-world-cup-soccer-premium-hobby-box/',10)
ON CONFLICT (product_code, name) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Which sections come out of which box
-- ---------------------------------------------------------------------------

-- Everything in product A is in the Hobby box.
INSERT INTO box_contents (box_id, section, availability, note)
SELECT b.id, c.section, 'included', NULL
  FROM product_boxes b
  CROSS JOIN (SELECT DISTINCT section FROM cards WHERE product_code = 'A' AND NOT is_custom) c
 WHERE b.product_code = 'A' AND b.name = 'Hobby'
ON CONFLICT DO NOTHING;

-- Kaboom!: widely reported as a hobby-exclusive SSP, but the checklist sources
-- do not restrict it, so it is recorded as REPORTED rather than as fact. This
-- distinction matters — "hobby exclusive" is a selling point you shouldn't make
-- to a buyer unless it's true.
UPDATE box_contents bc SET availability = 'reported_exclusive',
       note = 'Reported as a Hobby-exclusive short print. Checklist sources do not confirm the restriction — verify before advertising it as hobby-only.'
  FROM product_boxes b
 WHERE bc.box_id = b.id AND b.product_code = 'A' AND b.name = 'Hobby'
   AND bc.section IN ('Kaboom!', 'Kaboom! Oversize');

-- Autographs and memorabilia are the guaranteed hobby hit.
UPDATE box_contents bc SET note = 'The guaranteed autograph hit in a Hobby box.'
  FROM product_boxes b
 WHERE bc.box_id = b.id AND b.product_code = 'A' AND b.name = 'Hobby'
   AND bc.section IN ('Signature Series','Beautiful Game Autographs','Beautiful Game Dual Autographs');

-- Hobby International: same checklist, one exclusive parallel line.
INSERT INTO box_contents (box_id, section, availability, note)
SELECT b.id, c.section, 'included', NULL
  FROM product_boxes b
  CROSS JOIN (SELECT DISTINCT section FROM cards WHERE product_code = 'A' AND NOT is_custom) c
 WHERE b.product_code = 'A' AND b.name = 'Hobby International'
ON CONFLICT DO NOTHING;

UPDATE box_contents bc SET availability = 'exclusive',
       note = 'Optic Argyle parallels are only found in Hobby International boxes.'
  FROM product_boxes b
 WHERE bc.box_id = b.id AND b.product_code = 'A' AND b.name = 'Hobby International'
   AND bc.section = 'Base Optic';

-- Blaster / Fat Pack: base, Optic and inserts, but no guaranteed auto or memo.
INSERT INTO box_contents (box_id, section, availability, note)
SELECT b.id, c.section, 'included', NULL
  FROM product_boxes b
  CROSS JOIN (SELECT DISTINCT section FROM cards
               WHERE product_code = 'A' AND NOT is_custom
                 AND section NOT IN ('Signature Series','Beautiful Game Autographs',
                                     'Beautiful Game Dual Autographs','Kaboom!','Kaboom! Oversize')) c
 WHERE b.product_code = 'A' AND b.name IN ('Blaster','Fat Pack')
ON CONFLICT DO NOTHING;

UPDATE box_contents bc SET note = 'Blasters guarantee 6 Rated Rookies — the reason to buy one.'
  FROM product_boxes b
 WHERE bc.box_id = b.id AND b.product_code = 'A' AND b.name = 'Blaster'
   AND bc.section IN ('Base','Base Optic','Rookie Kings');

-- Product B: one configuration, so everything comes from it.
INSERT INTO box_contents (box_id, section, availability, note)
SELECT b.id, c.section, 'included', NULL
  FROM product_boxes b
  CROSS JOIN (SELECT DISTINCT section FROM cards WHERE product_code = 'B' AND NOT is_custom) c
 WHERE b.product_code = 'B' AND b.name = 'Premium Hobby'
ON CONFLICT DO NOTHING;

UPDATE box_contents bc SET odds = '1:4067', availability = 'included',
       note = 'The Glory Cup Manka is limited to 5 copies at roughly 1 in 4,067 packs.'
  FROM product_boxes b
 WHERE bc.box_id = b.id AND b.product_code = 'B' AND b.name = 'Premium Hobby'
   AND bc.section = 'Glory Cup';

UPDATE box_contents bc SET note = 'Gilded cards are numbered to 299; Gold Etched to 399 and /5.'
  FROM product_boxes b
 WHERE bc.box_id = b.id AND b.product_code = 'B' AND b.name = 'Premium Hobby'
   AND bc.section IN ('Gold Leaf','Golden');
