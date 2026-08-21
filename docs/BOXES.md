# Boxes, packs and card types

## What's verified, and what isn't

`product_boxes.verified = TRUE` means the configuration was corroborated by product
coverage. `box_contents.availability = 'reported_exclusive'` means a source claimed
exclusivity that other sources don't confirm — the UI labels those "reported only
here" rather than showing them as fact.

That distinction is the point of this file. "Hobby exclusive" is a selling point,
and asserting it to a buyer when it isn't true is the kind of mistake that costs you
a reputation, not just a sale.

## Donruss Road to FIFA World Cup 25/26

| Configuration | Channel | Packs × cards | Total | Guaranteed |
|---|---|---|---|---|
| Hobby | hobby | 12 × 30 | 360 | 1 autograph + 1 memorabilia |
| Hobby International | international | 12 × 30 | 360 | 1 autograph |
| Blaster | retail | 6 × 15 | 90 | 6 Rated Rookies |
| Fat Pack | retail | 12 × 25 | 300 | 2 Rated Rookies |

Per-box contents, as reported: Hobby gives 6 numbered parallels, 12 Optic Holo and 48
inserts or insert parallels. Hobby International swaps in 12 **Optic Argyle**, which
is the one exclusivity both sources agree on, and drops to 3 numbered parallels.
Blaster gives 1 numbered parallel, 1 Optic Holo and 18 inserts.

**Kaboom! is recorded as `reported_exclusive` to Hobby.** One product review calls it
a hobby-exclusive SSP; the checklist sources place no restriction on it. Verify before
advertising a Kaboom as hobby-only.

## Panini × Kayou FIFA World Cup 2026

| Configuration | Channel | Packs × cards | Total |
|---|---|---|---|
| Premium Hobby | hobby | 10 × 6 | 60 |

769 cards in the base checklist before parallels; roughly 3–4 base and 2–3 inserts
per pack. Base parallels run silver /299, red /199, blue /99, orange /26. Gilded is
numbered /299 and Gold Etched /399 and /5. The **Glory Cup Manka** is limited to 5
copies at roughly **1 in 4,067** packs.

## Card types

`card_type` is the set-level category, derived from the section:

| Type | Sections |
|---|---|
| Base | Base |
| Base Optic | Base Optic |
| Autograph | Signature Series, Beautiful Game Autographs |
| Dual Autograph | Beautiful Game Dual Autographs |
| Promo | Promotional |
| Insert | Kaboom!, Night Moves, Animation, Kit Kings, and every other named subset |
| Custom | cards you created with no subset given |

`variant_type` is the copy-level category, derived from the parallel and grade:
Raw base → Parallel → Numbered /N → One of one, each of which can also be Graded.

## Correcting any of it

```sql
-- your local price for a box, so "value by box" can compute a real return
UPDATE product_boxes SET msrp_aud = 165 WHERE product_code='A' AND name='Hobby';

-- you confirmed Kaboom really is hobby-only
UPDATE box_contents bc SET availability = 'exclusive',
       note = 'Confirmed hobby-exclusive.'
  FROM product_boxes b
 WHERE bc.box_id = b.id AND b.product_code='A' AND b.name='Hobby'
   AND bc.section = 'Kaboom!';

-- a configuration that isn't seeded (mega box, hanger, tin)
INSERT INTO product_boxes (product_code, name, channel, packs_per_box, cards_per_pack,
                           cards_per_box, guaranteed, verified)
VALUES ('A','Mega','retail',10,15,150,'1 Optic parallel',FALSE);

-- record which box one of your cards came out of
UPDATE holdings SET box_id = (SELECT id FROM product_boxes
                               WHERE product_code='A' AND name='Blaster')
 WHERE sku_id = 214;
```

Then reload the dashboard — the type and box fields are views, so there is nothing
to recompute.
