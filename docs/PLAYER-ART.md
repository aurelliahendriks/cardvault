# Player art: what to generate, and what not to

## Read this first

**CardVault does not rely on generated likenesses of real footballers.** Real-player
portraits come from appropriately licensed photographic sources, while generated
artwork is restricted to anonymous, non-identifiable football figures, poses, textures
and visual effects.

Two reasons that decision is the engineering one and not just a legal one:

1. **Rights.** A generated likeness of a named player, used as an asset in a tool you
   operate commercially, runs into personality/publicity rights, and Panini and FIFA
   hold the licensed likeness rights for these products.
2. **It doesn't scale, and it doesn't need to.** Identity is *data* — a licensed
   photograph, an author, a licence — and it belongs in the database. Art is a
   *renderer*: eight poses and a handful of textures cover 1,771 cards, where
   per-player generation would need 1,771 assets and still be wrong on the faces.
   Whatever an image service will or won't produce, generating per-player art is the
   more expensive architecture for a worse result.

**For real faces, the app already has a better answer:** portraits from Wikidata /
Wikimedia Commons — free, no key, properly licensed, and an actual photograph of the
actual player. `npm run portraits`. See `docs/PORTRAITS.md`.

**What generated art is genuinely good for:** consistent, stylised, *non-identifiable*
art. Position poses, action silhouettes, celebration shapes, kit-coloured figures,
background textures.

## Every player looks different — without inventing anyone's appearance

Pose comes from position and colour comes from nation, so early on every Spanish
midfielder rendered identically. In a grid of 180 that reads as a bug rather than a
system. `src/media/avatarStyle.ts` fixes it by varying the **staging**, all derived from a
hash of the name so a player's tile is stable across sessions and installs:

| varies | values |
|---|---|
| backdrop | spotlight · rays · arc · band · halo · grid |
| accent | eight low-chroma tints, chosen so the kit still reads |
| facing | mirrored or not |
| scale | 0.92–1.06, so heads don't all line up in a grid |
| tempo & phase | motion speed and offset, so a row doesn't pulse in lockstep |

Measured across the 783 players on the checklist: **523 distinct staging combinations**,
and within Argentina alone 22 distinct stagings across 31 players — before pose and kit
multiply it further.

**What deliberately does not vary: anything about the person.** No skin tone, no build, no
hair, no face. Those would be fabricated claims about identifiable people, which is the
entire reason the art is anonymous. A test asserts the style object's keys, so if a field
called `skinTone` ever appears, that test is what should stop it.

Icons and cards the checklist flags hot get the marquee treatment — rays, a warm rim, a
slightly larger figure — because a collection is *about* those players.

**If you want genuinely per-player pictures, the real answer is still photographs.**
`npm run portraits` pulls properly licensed portraits from Wikimedia and they take over
from the generated art automatically. Generated staging is what makes the fallback
readable, not a substitute for a real face.

## Exporting the pack

One picture per player, as files:

```bash
npx tsx tools/export-avatar-pack.ts ./player-pack     # 783 SVGs + index.html + CREDITS.txt
node  tools/export-avatar-pngs.mjs  ./player-pack     # rasterise, 8 sheets not 783 shots
python3 tools/slice-pack-sheets.py  ./player-pack     # slice the sheets into 256px PNGs
```

The PNG step lays the avatars out in exact 256px cells, screenshots eight sheets and
slices them, rather than taking 783 individual element screenshots — same output, a
fraction of the round-trips. (First attempt produced 783 black squares: `setContent`'s
`baseURL` does not resolve a relative `<img src>`. It now writes the sheet into the pack
directory and navigates to it, the way a browser would.)

`CREDITS.txt` records provenance per file: photographs carry their author and licence and
**must** keep the attribution; generated figures carry none and need none. Re-run the
export after `npm run portraits` and the photographs come through in place of the art.

## Animation

The avatars move. Each pose has its own idle: a standing figure breathes, a runner leans
and bobs, a striker's leg swings on a delay, a keeper glides through the dive, a
celebration pulses. It is whole-figure transforms only — there is one silhouette path per
pose, no rigging — and that constraint is doing real work, because a bob or a lean reads as
life at 96px where a faked articulated limb reads as broken.

The CSS lives *inside* the SVG, since these are served to `<img>` tags where a page
stylesheet cannot reach them.

**The bug worth recording:** a `prefers-reduced-motion` media query inside an
`<img>`-loaded SVG is **not** honoured by the browser. I assumed it would be, then tested
it by screenshotting the same grid 750ms apart and comparing pixels — the frames still
differed under emulated reduced motion. Motion that ignores an accessibility setting is
worse than no motion, so the decision moved out of the image entirely:

- the dashboard evaluates `matchMedia` itself and appends `?anim=0`
- the server also honours the `Sec-CH-Prefers-Reduced-Motion` client hint, with
  `Accept-CH` and `Vary` set so caching stays correct
- the in-SVG query stays as a third line of defence where it does work

`tools/check-avatars.mjs` asserts all three: animated frames differ, `?anim=0` frames are
identical, the client hint produces identical frames, and the dashboard adds the parameter
under reduced motion. The offline preview honours it too — it captures one variant and
strips the `<style>` block when asked for a still.

**For real frame-by-frame motion** — an actual run cycle rather than an idle — the route is
the 8-frame sprite sheet in the prompt pack below, driven by `steps(8)`. The importer
already handles multi-figure sheets; a frame sheet is the same problem with the components
in a row.

## The pipeline

```
PLAYER
  ├── manual portrait?      → use it (never overwritten by the backfill)
  ├── Wikimedia portrait?   → use it, with author + licence + source stored
  └── otherwise             → generated avatar
                                ├── nation kit colours + pattern
                                └── position → one of eight poses

CARD
  └── print run / parallel / grade → one CSS class
                                       └── shimmer · gold · cracked ice · foil · slab
```

Identity resolves top-down and stops at the first hit. Art is a renderer at the
bottom. Nothing in the second block touches image files at all, which is why a new
parallel costs zero assets.

## What ships in the box — no image model required

**Two pose families, same eight poses.** `POSE_ART=geometry` picks the hand-authored
pictograms; the default is `traced`, which is the generated sheet imported through
`python3 tools/import-pose-sheet.py <sheet.png>`. That importer does not slice on a fixed
grid — a real generated sheet has uneven cells, figure heights varying by a third, and a
ball drawn beside a boot landing in the neighbouring cell. It finds components by alpha,
reattaches each ball to the figure it belongs to, normalises into the same 300×300 band,
writes PNG-8 to `web/assets/poses/` (~5 KB each) and traces to SVG paths (~1.3 KB each) in
`src/media/poses-art.ts`. The traced path is what the app uses: it scales to any tile and
takes its colour from the same two-pass ink/rim treatment, so a generated figure stays
legible over Croatia's checks where a flat PNG would not.

**Eight poses, as SVG.** `src/media/poses.ts`. Standing, walking, running, striking a
ball, celebrating, sliding tackle, goalkeeper dive, heading. Faceless pictograms, pure
geometry with no paint attributes, so the same pose serves all 56 nations — the caller
supplies the colours. About 1 KB each, scale to any size, recolour from data.

Position picks the pose, and an unknown position picks `standing` rather than guessing:

| position | pose |
|---|---|
| goalkeeper, sweeper-keeper | goalkeeper dive |
| forward, striker, centre-forward | striking a ball |
| winger | running |
| any midfielder | walking |
| centre-back, full-back, defender | sliding tackle |
| unknown / missing | standing |

Position arrives three ways, most authoritative first: `manual` (you set it, or you
pinned a pose outright), `wikidata` (P413, read during the portrait backfill and
matched on the item's *label* rather than a memorised QID), `seed` (a short
hand-checked list). Most of the 783 players have no position and draw the neutral
figure — that is the intended state, not a gap to fill with guesses.

```bash
# pin a pose regardless of position, or clear it
curl -X POST localhost:8080/api/players/Lionel%20Messi/pose \
  -H 'Content-Type: application/json' -d '{"pose":"celebrating"}'
curl -X POST localhost:8080/api/players/Lionel%20Messi/pose \
  -H 'Content-Type: application/json' -d '{"pose":null}'

# or set the position and let the mapping choose
curl -X POST localhost:8080/api/players/Some%20Player/pose \
  -H 'Content-Type: application/json' -d '{"position":"goalkeeper"}'

curl localhost:8080/api/poses      # the vocabulary, and how many players draw each
```

**Eight rarity rungs, as CSS.** No textures to download, no per-parallel art. The
picture is the same asset at every rung; a stack of gradients over it carries the
scarcity.

| rung | trigger | cues (each rung keeps the ones below it) |
|---|---|---|
| Base | no parallel, no serial | nothing |
| Unnumbered special | unnumbered parallel, insert, promo or auto | faint sweep + cool tint |
| Gold parallel | gold/bronze/copper/amber, unnumbered | **same intensity**, warm hue |
| Scarce | print run 100+ (incl. /199) | brighter sweep + tint + corner glow |
| Scarcer | print run 50–99 | ↑ all of it, much brighter glow |
| Very scarce | print run 26–49 | + cracked ice (hard-stop gradient fractures) |
| Ultra scarce | print run 11–25 | + foil ring, 1px rim, parallax tilt |
| Elite | print run 2–10 | + stronger foil, 2px warm rim, faster |
| One of one | print run 1 | + saturated foil, 3px rim, breathing pulse |
| *(any grade)* | a grader is set | glass highlight, on top of whatever rung |
| *(gem grade)* | PSA/SGC 10, BGS 9.5+, Black Label | a little more glass, still not a rung |

**The rule that makes it a ladder: every rung adds a cue, never swaps one.**
Different-but-not-more reads as "another variant"; more-plus-one-new-thing reads as
"rarer".

**Print run beats the colour word.** A Gold /10 is a /10, not gold: the number is a
fact, the colour is a label. And an unnumbered Gold sits at the *same* intensity as an
unnumbered Purple, because it isn't scarcer than a /99 — encoding it as "more" is the
kind of lie a collector spots instantly.

One function decides the rung for the gallery tile, the player-page row and the detail
hero, so they can't disagree. The ladder renders side by side under **Data & sources →
Rarity effects**. `✦ Effects` turns the lot off; `prefers-reduced-motion` does it
automatically.

### The hierarchy is measured, not eyeballed

`bash tools/verify-hierarchy.sh` freezes every animation at a fixed phase, screenshots
each rung, and computes three things against the base tile: luminance change,
Hasler-Süsstrunk colourfulness, and gradient energy (structure). It asserts the
composite rises monotonically — **and rises with colour removed entirely**, because a
ladder that only ascends in hue is invisible to a deuteranope. It runs at both grid
sizes, under `prefers-reduced-motion`, and with effects off (where it asserts
*flatness* instead).

```
step          tier           dL  chroma   edge   score    grey  step-up
Base          base         0.00    0.00   0.00     0.0     0.0
Gold parallel gold         3.67    2.29   0.41     5.0     4.0  +5.0
Parallel      silver       3.77    0.00   0.42     3.3     4.1  =      ← same rung
/199          scarce      14.98   11.76   1.26    20.8    14.6  +15.8
/99           scarcer     23.06   13.38   1.68    27.5    21.4  +6.7
/49           ice         29.06   14.58  10.07    60.3    61.5  +32.8  ← structure arrives
/25           foil        36.89   21.45  10.03    69.3    66.1  +9.0
/10           elite       45.74   25.93  10.14    77.5    72.0  +8.2
1/1           unique      91.63   20.39   8.97    91.7    94.9  +14.2
PSA 10 slab   base         7.08    0.00   1.34     8.1    10.1  (not on the ladder)
```

**Grading is measured too.** The harness renders a graded twin of every rung and
asserts two things: a graded card never scores *below* its raw twin (glass adds, never
replaces), and grading never pushes a card up to the rung above it — a graded /199 must
still read below a raw /99. That second assertion is the precise form of "condition must
not outrank scarcity", and it caught the worst bug in the set: the slab glass was
overriding the sweep with `!important`, so a PSA 10 Gold /10 rendered *weaker* than the
raw /10. Condition was literally deleting a scarcity cue.

Five real bugs it caught, none of which survived contact with a number:

1. **An unnumbered Gold parallel measured *stronger* than a /99.** A warm tint moves
   more luminance than a cool one, so the flavour outranked two numbered rungs.
2. **/25 measured *weaker* than /49.** Foil replaced the fracture lines instead of
   joining them, so the higher rung had less structure. This is where the
   never-remove-a-cue rule came from.
3. **The sample labels were being measured, not the effects.** Captions sat over the
   artwork; text is high-contrast edges, so the score partly reflected how long each
   label was. Labels now sit under the swatch — better UI as well, since a caption over
   a sample hides the thing the sample exists to show.
4. **The reduced-motion fallback flattened the top three rungs.** With the sweep parked
   at full strength everything clipped to the same white. It now parks at 78%.
5. **The grade layer was deleting a rarity cue** (see above), and an unnumbered Kaboom
   was scoring as a plain base card — an insert is not base, though it can't rank above
   a numbered card either, since an insert ratio is not a print run.

Two more things only screenshots caught: the foil started full-bleed and *erased* the
card it was decorating (the same mistake as full-bleed portraits, one layer up), and the
figure needs a rim drawn underneath in the opposite tone or it vanishes over Croatia's
checks.

## Slicing the collection: nation, position, club

Three filters, three different provenances, which is worth knowing before you trust
them:

- **Nation** comes free with the checklist. These are World Cup products, so
  `cards.team` *is* the country. Complete and reliable.
- **Position** is `players.position`, from the same places the pose comes from.
- **Club** is `players.club`, and Panini doesn't print it — the checklist has no club
  data at all. It arrives from Wikidata P54 or by hand, and it is explicitly a
  **snapshot**: squads change every window, so `club_source` and `fetched_at` are how
  you judge a row. The player page marks seeded values "snapshot".

P54 is a career history, not a field — a veteran has a dozen statements. The current
club is the one with **no end date** (P582); a preferred open statement beats a merely
normal one, deprecated statements are ignored, and if two are still open (overlapping
loans, or a mid-edit page) it stores **nothing** rather than picking. A club filter
that quietly shows last season's squad is worse than one that admits it doesn't know.

Both filters offer an explicit "unknown" option, because that bucket is large and
hiding it makes the filter look broken. Counts in the dropdowns are SKUs — the same
unit the gallery renders — so "Real Madrid (32)" shows exactly 32 tiles.

```sql
-- correct one by hand; 'manual' is never overwritten by the backfill
UPDATE players SET club='Bayern Munich', club_source='manual' WHERE name='Harry Kane';
UPDATE players SET position='goalkeeper', position_source='manual' WHERE name='Some Player';
```

## What the app already does without any AI

Every player gets a picture immediately: a silhouette in a position-appropriate pose on
their nation's kit colours and pattern — Argentina's sky-blue stripes, Croatia's red checks,
the Netherlands' orange, Qatar's maroon. 56 nations, about 1 KB each, no model, no
licence question. If a nation's colours are wrong:

```sql
UPDATE nation_kits SET primary_hex='#75AADB', secondary_hex='#FFFFFF',
       pattern='stripes', verified=TRUE
 WHERE team='Argentina';

-- patterns: 'solid' | 'stripes' | 'checks' | 'halves'
INSERT INTO nation_kits (team, primary_hex, secondary_hex, pattern, verified)
VALUES ('Curaçao', '#002B7F', '#FFD100', 'solid', TRUE)
ON CONFLICT (team) DO UPDATE SET primary_hex=EXCLUDED.primary_hex;
```

`verified = false` rows are best guesses and flagged as such. Check `/api/kits`.

## Prompts, if you want raster art as well

Everything above already works. These prompts are for the case where you want richer,
painted versions of the same eight poses, or real image textures instead of CSS
gradients — a nicer look at the cost of files to host and compress.

### 1. Position poses — one reusable set

Paste this as-is. It asks for a sprite sheet, which is what makes the output usable
rather than twelve inconsistent one-offs. Ask for the same eight poses the app already
uses, so raster and SVG stay interchangeable.

> Create a single image containing a 4×2 grid of eight flat vector-style football
> player figures, viewed from the front, on a fully transparent background.
> No faces, no facial features, no identifiable person — stylised anonymous
> silhouette-style figures only, like pictograms.
> The eight poses, left to right, top row then bottom: standing arms at sides;
> running; striking a ball; celebrating with both arms raised; sliding tackle;
> goalkeeper diving right; heading a ball; walking.
> Style: flat single-colour fill, no gradients, no outlines, no shadows, no text.
> Fill colour pure white (#FFFFFF) so it can be recoloured programmatically.
> Each figure centred in its cell with even padding, consistent height across all
> eight, consistent line weight and proportions.
> Output 2048×1024 pixels, PNG with alpha.

Then: **"Now the same eight poses, same style and proportions, from a 3/4 rear view."**
Consistency comes from asking for variations of one sheet, not from new prompts.

### 2. Rarity backgrounds — texture, not people

> Create a seamless square abstract texture for a trading-card background, 1024×1024
> PNG. Style: dark charcoal base with a subtle diagonal prismatic refractor shimmer,
> like a holographic foil card. No text, no logos, no figures, no faces. Low contrast,
> so overlaid white text stays readable. Tileable edges.

Repeat with: *comic-book starburst rays from the centre*, *brushed gold foil*,
*cracked-ice fracture pattern*. One per rarity tier.

### 3. Nation colour blocks — if you'd rather not use flat SVG

> A set of 12 abstract vertical banner graphics, 512×768 each, arranged in a grid.
> Each uses only two flat colours in a football-kit pattern: solid, vertical stripes,
> or a chequerboard. No flags, no crests, no text, no emblems, no figures.
> Flat colour only, hard edges, no gradients. PNG.

Supply the colour pairs yourself from `nation_kits` — asking a model to recall 56 kit
colour schemes is asking it to guess, and it will.

### 4. Animation

Image models produce **stills**. For motion you have two realistic routes:

**Sprite sheet → CSS animation.** Ask for the frames explicitly:

> A single horizontal sprite sheet: 8 frames of one flat white anonymous football
> player figure completing one running cycle, evenly spaced, each frame in a 256×256
> cell, transparent background, consistent figure height and position across frames,
> flat single-colour fill, no outlines, no text. Output 2048×256 PNG with alpha.

Then in CSS — no library, no JS:

```css
.runner {
  width: 256px; height: 256px;
  background: url(/assets/run-cycle.png) 0 0 / 2048px 256px;
  animation: run .8s steps(8) infinite;
}
@keyframes run { to { background-position: -2048px 0; } }
```

**Better for a card tracker: don't generate the animation at all.** The effects that
actually suit rare cards — a foil shimmer sweep, a slow parallax tilt, a pulse on a
sell-now badge — are a few lines of CSS on the art you already have, weigh nothing, and
never look off-model:

```css
@keyframes shimmer { to { transform: translateX(240px) rotate(18deg); } }
.card.rare .shot::before {
  content: ""; position: absolute; inset: -20% -60%;
  background: linear-gradient(105deg, transparent 40%, rgba(255,255,255,.28) 50%, transparent 60%);
  animation: shimmer 2.6s ease-in-out infinite;
}
```

## Making the output light enough

This is where generated assets usually go wrong — a 4 MB PNG per player is unusable in
a 180-tile grid.

| Asset | Target size | Format |
|---|---|---|
| Player figure / pose | **under 15 KB** | PNG-8 with alpha, or trace to SVG |
| Rarity background texture | under 60 KB | WebP, quality ~72 |
| Sprite sheet (8 frames) | under 80 KB | PNG-8 with alpha |
| Player portrait | under 25 KB | WebP or JPEG, 320 px wide |

Ask for it explicitly in the prompt — *"flat single-colour fill, no gradients, no
shadows, no outlines"* — because gradients and soft shadows are what make a flat
graphic weigh 2 MB instead of 8 KB.

Then compress locally:

```bash
# flat art -> tiny PNG-8
pngquant --quality=60-85 --speed 1 --force --ext .png figure.png

# textures and photos -> WebP
cwebp -q 72 -m 6 texture.png -o texture.webp

# flat vector-style art -> SVG, which is usually the smallest possible answer
potrace -s -o figure.svg figure.pbm      # after: convert figure.png figure.pbm
```

**For flat single-colour figures, trace to SVG.** It'll land around 2–4 KB, scale to
any size, and recolour with a CSS `fill` — which is exactly why the app's own
silhouettes are SVG and about a kilobyte.

## Getting the assets into CardVault

Per-player art needs no new code — the manual-portrait endpoint takes any image:

```bash
B64=$(base64 -w0 my-generated-figure.png)
curl -X POST "localhost:8080/api/players/Some%20Player/portrait" \
  -H 'Content-Type: application/json' \
  -d "{\"photo\":\"data:image/png;base64,$B64\",
       \"author\":\"Generated with <model>\",
       \"license\":\"Own work\"}"
```

Manual portraits are never overwritten by the Wikimedia backfill, so generated art and
real photographs coexist — real photo where one exists, your art everywhere else.

Backgrounds and sprite sheets go in `web/assets/` and are served as static files.

Record what generated each asset in the `author` field. In a year you will not
remember, and if the licensing position on model output shifts you'll want to know
which files are affected.
