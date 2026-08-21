# Architecture and design decisions

This document records *why* things are the way they are. The code has the how.

## The problem the HTML tracker couldn't solve

The original single-file tracker was a good checklist: 1,771 cards across Donruss
Road to World Cup 25/26 and Panini FIFA World Cup 2026, 23 parallel groups, 92 cards
flagged hot, and a hand-built AUD estimate on every line. What it couldn't do:

1. **Prices were frozen.** Every estimate was a point-in-time judgement. In a
   post-tournament market where non-icon cards shed 20–40% over months, a frozen
   estimate becomes wrong in a predictable direction.
2. **No venue model.** It could tell you a card was worth A$100. It couldn't tell
   you that A$100 on eBay US nets less than A$92 on eBay AU once you count the
   international surcharge, A$18 postage instead of A$9, and tariff drag on US bids.
3. **No community model.** "Where to sell" and "which marketplace" are different
   questions, and the second one is often the less useful of the two.
4. **No provenance.** A seeded guess and a figure backed by twelve sold comps looked
   identical on screen.

Everything below follows from those four gaps.

## Data model

The central abstraction is the **SKU**: `card + parallel + grade`. Prices attach to
SKUs, not cards, because a raw base Yamal, a Blue /49 Yamal and a PSA 10 Yamal are
three different markets that happen to share a checklist row. Comps that mix them are
worse than no comps.

```
cards ──┬─▶ skus ──┬─▶ comps ──▶ valuations ──▶ recommendations
        │          ├─▶ velocity
parallels ─────────┘  └─▶ holdings / sales
```

`comps` keeps one row per resolved listing, including the rejected ones, with the
reason. That's deliberate: when a price looks wrong, the first question is always
"what did the matcher think it was looking at", and throwing away rejections makes
that unanswerable.

### Two constraint details that were bugs first

`valuations` and `velocity` both use `marketplace_code IS NULL` to mean "global
blended". A plain `UNIQUE` constraint treats NULLs as *distinct*, so `ON CONFLICT`
never fired for global rows and every re-run inserted a duplicate. Both now use
`CREATE UNIQUE INDEX ... NULLS NOT DISTINCT`. `velocity` originally had a composite
`PRIMARY KEY` including `marketplace_code`, which made it implicitly `NOT NULL` and
crashed on every global write.

## Matching: three tiers, cheapest first

Comp quality is the whole ballgame. One mismatched listing at 30× the real price
does more damage than ten missing comps, because the missing ones widen your error
bars honestly and the wrong one moves your centre.

**Tier 1 — deterministic parse + card number.** `match/titleParse.ts` extracts card
number, grader and grade, print run, parallel words, section, product, auto/rookie
flags, and hard rejects. Free, stable, and resolves the majority of real titles.
Stability matters as much as cost: the same title always yields the same parse, so
valuations don't drift when a model version changes.

**Tier 2 — trigram + word similarity.** `word_similarity` is the load-bearing half.
Plain `similarity('lamine yamal', 'yamal')` scores below any usable threshold, and
surname-only titles are a large share of real listings. `word_similarity` measures
how well the needle matches *any portion* of the target, which is exactly the
question being asked.

**Tier 3 — LLM adjudication.** Only for genuine ambiguity, on the top 5 candidates,
with an explicit instruction that confidence below 0.7 means "drop it" — because
dropping an ambiguous comp is the correct outcome, not a failure. `CONF_LLM` is set
low (0.32) on purpose: titles like "Messi Kaboom!" with no card number score badly
on trigrams but are trivial for a model, and silently dropping them loses the best
comps on the most valuable cards in the set.

### Four matching bugs worth remembering

- **Product hints must never filter.** Both products are Panini World Cup products,
  so "Panini FIFA World Cup 2026" does not identify which one. An early version used
  product hints as a SQL filter, which silently excluded *every correct match* for
  cards in the Donruss set — including Gilberto Mora #214 and every Kaboom. Product
  is now scored, with strong signals ("Donruss", "25/26") separated from weak ones
  ("World Cup").
- **`25/26` is a season, not a print run.** It was creating phantom "/26" parallels
  and splitting a card's comps across two SKUs.
- **Graders appear without grades.** "BGS Black Label" names no number. Grader
  detection is now independent of grade detection.
- **A unique (player, section) pair is an identification.** "Lionel Messi Kaboom"
  has no card number, but exactly one Messi Kaboom exists in the checklist. Scoring
  this as a bonus left every such listing parked just below the accept threshold, so
  it is now a decisive accept rule with its own capped confidence.

## Valuation: robust by necessity

Card comps break every assumption a normal average makes. `valuation/stats.ts` uses:

- **Median centre, MAD spread.** Not mean/SD, because the outliers are exactly what
  corrupted the mean. Not IQR, because IQR is unusable below n≈8.
- **A ratio fallback when MAD collapses.** MAD hits zero whenever more than half the
  sales share a price — which is the *normal* case for cheap base cards (five sales
  at A$4.00, one mismatched listing at A$400). A z-score is undefined there, so the
  fallback tests distance as a multiple of the median. Prices are multiplicatively
  distributed, so "3× off the median" is the meaningful notion of far away.
- **Never discard more than 30% of the evidence**, however strange it looks.
- **Recency weighting with a tier-dependent half-life.** 30 days for ordinary cards,
  55 for premium inserts, 75 for icons. One global half-life would systematically
  overprice the breakout rookies and underprice the Messis.
- **Confidence from sample size, agreement and freshness**, surfaced in the UI. n=1
  reports 0.28 and says "a data point, not a market".

When comps run out it falls down a visible ladder: `comps → parallel_mult →
tier_avg → seed`. Print-run scaling is sub-linear (a /10 is not 10× a /100), with a
hard premium for 1/1s.

## Where to sell: net proceeds, not headline price

`valuation/fees.ts` is the only place marketplaces are allowed to be compared, and
it subtracts:

- final value fee (13.25% + A$0.40 equivalent for eBay cards, per-site)
- the 1.65% international transaction surcharge, which applies on every offshore
  sale from an Australian seller
- promoted-listing rate, when modelling a card that realistically needs ads
- postage from Australia (A$9 domestic vs A$16–25 offshore — decisive on cheap cards)
- **demand-side** drag from buyer import duty, modelled as a haircut on gross rather
  than a fee, because it suppresses bids rather than billing you

`recommend/venue.ts` then adds the two things that made the first version wrong:

- **`price_realization`.** Without it, any zero-fee venue looked like a 100%-keep
  sale and outranked eBay on everything. A A$24,000 PSA 10 Messi Kaboom was being
  routed to a local card shop. Shops pay 40–60% of market *because* they're instant
  and fee-free; auction houses can exceed 1.0 at the top end, which is what their
  20% seller cost buys you.
- **Value bands.** A venue can be wrong for a card regardless of arithmetic. A A$7k
  card doesn't sell in a Facebook group at any price, because buyers at that level
  want escrow and a track record.

Regional demand priors (Mexico squad above global on MercadoLibre MX, Spain squad on
eBay ES, Kabooms on eBay US) apply *only* until a marketplace has its own comps, at
which point real data takes over completely. The priors exist to make a cold start
useful, not to be believed forever.

## Communities: a different question

`recommend/community.ts` scores channels on fit rather than price: section focus,
nationality focus, value band, lot-friendliness, speed weighted by how much urgency
the timing model reports. A channel that pays more but is a bad fit will sit unsold,
which is worth nothing.

`shouldLot()` exists for the specific pathology of big-name base cards: the most
liquid cards in the product, 2–6 sales a day, and completely worthless individually
once postage and the fixed per-order fee are subtracted.

## Timing: the post-tournament clock

The 2026 final was 19 July 2026. `recommend/timing.ts` classifies each player into a
decay tier and models value retention at 30/90/180 days toward a tier-specific floor:

| Tier | Half-life | Retained floor |
|---|---|---|
| icon (Messi, Ronaldo) | 900d | 97% |
| elite (Mbappé, Haaland, Yamal) | 400d | 85% |
| tournament star | 150d | 62% |
| host nation (MX/US/CA) | 110d | 58% |
| breakout rookie | 95d | 55% |
| ordinary | 200d | 72% |

Urgency blends modelled decay with the *observed* 30-day comp trend, and observed
data wins — an actual downtrend is stronger evidence than any model.

## Grading: the calendar, not just the fee

`recommend/grading.ts` implements two gates that both have to pass — raw value
≥ A$150 *and* modelled PSA 10 comp ≥ 3× total grading cost — using realistic
Australian numbers (A$55–70 all-in via a local middleman, 4–8 months once transit
and consolidation are counted) and conservative gem rates (22% for full-bleed
Kabooms, where centering and print lines cap a lot of cards at 9).

Then `recommend/engine.ts` does the thing most grading calculators skip: it
discounts the graded EV by the decay expected during the months in the queue. On a
tournament-premium card that frequently turns a "grade" into a "borderline" with the
explanation *the grading maths works; the calendar does not*.

## AI: three places, all optional, all bounded

1. **Listing match adjudication** (Haiku) — ambiguous titles only.
2. **Sell reasoning** (Sonnet) — rewrites deterministic analysis into prose, on cards
   above A$100. The deterministic text is always computed first and is what gets
   stored if the AI call fails, so recommendations never depend on a model being up.
3. **NL → SQL** — the model writes a query and never executes one.

Spend is capped by `AI_MONTHLY_BUDGET_USD`, tracked in `ai_queries` and enforced
before every call.

### The NL query boundary

Three independent layers, because any one of them can be wrong:

1. The model only ever sees a whitelist of readable relations.
2. `guardSql()` rejects anything that isn't a single bare `SELECT`/`WITH` — no
   stacked statements, no comments, no system catalogs, no non-whitelisted relations,
   no write verbs anywhere (including hidden in a CTE), limit clamped to 200.
3. Execution happens in a `BEGIN READ ONLY` transaction with a statement timeout.

`test/guard.test.ts` covers the attack shapes. The guard rejects; it never tries to
repair a query.

## Cost control

Every external call is metered. `source_runs` is a ledger of requests and
`cost_units`, checked against `BRIGHTDATA_MONTHLY_REQUEST_CAP` *before* each Bright
Data call. The query ladder in `ingest/queryPlanner.ts` stops as soon as a rung
yields enough matched comps, so spend scales with how hard a card is to find rather
than with how many cards you own. `INGEST_MIN_VALUE_AUD` keeps 30-cent commons out of
the polling loop entirely — anything you hold or that's flagged hot is always
included regardless.

Self-scraping has a global single-flight mutex so `SCRAPE_MIN_DELAY_MS` is real even
under concurrency, plus a circuit breaker that disables the adapter for an hour after
three blocks rather than hammering a wall.

## Imagery

There is no card-image API for these sets and scraping an image host is a separate
legal problem — but every matched sold listing already carries a photograph of the
exact card. So the gallery is a free by-product of the pricing pipeline: for each
SKU, take the image from its highest-confidence recent comp.

Confidence is ranked *before* recency on purpose. A photo hanging off a shakily
matched listing may be a different card, and a wrong picture is worse than an old
one — it makes you misidentify what you own.

Images live on `skus`, not `cards`: a Blue /49 parallel and a PSA 10 slab do not
look like the raw base card, and showing the base photo for a graded card defeats
the point of a visual check. `sku_detail` resolves the fallback chain
(SKU photo → card photo → none) in SQL so the UI never needs a second request.

Three decisions worth keeping:

- **Proxy, don't hotlink.** `/api/img/:skuId` serves through a disk cache. Listing
  images vanish when listings are deleted, and a gallery that decays into broken
  thumbnails a month after you build your collection is worthless. When an upstream
  image does die, the route clears the dead URL and falls through to a placeholder.
- **Never 404.** The route always returns something renderable.
- **Generated art is load-bearing, and has to distinguish versions.** On a cold
  install there are zero listings, so the generated card *is* the gallery. It is not a
  generic empty-state box: five artwork families (base, optic, kaboom, auto, insert)
  are chosen from the section, the hue comes from colour words in the parallel name, a
  print run adds a foil band, and a grade renders the whole thing as a slab. So
  choosing Base Optic instead of Base, or Gold /10 instead of Teal /199, visibly
  changes the picture — which is the entire reason a card tracker shows pictures.
  The art is deliberately wordless: an earlier version printed the player, team and
  section into the SVG *as well as* the HTML tile overlay, and the two layers collided
  into unreadable mush.
- **SVG element ids must be namespaced per card.** Served through `<img>` each SVG is
  its own document, so `id="grad"` collisions are invisible. Inline two of them in one
  page — a contact sheet, an email, a print layout — and every card after the first
  silently adopts the first one's gradient. Found by building a contact sheet and
  seeing a Gold /10 render violet.
- **The add dialog previews artwork through a render-only endpoint.** Resolving a real
  SKU would also work, and would create a database row per keystroke.

### Photographs of the card you actually own

The imagery above is about what a card *looks like*. This is a different thing: what YOUR
copy looks like, corners and all, and it needed a different shape.

`skus.image_path` held one photograph per SKU for the whole database. That was right while
the database was one person, and became a data-loss bug the moment it was not. A SKU is
"Yamal Prizm #245 Pink Power, raw"; two friends can both own one; the second to upload
replaced the first, and the delete-the-old-file line removed the original from disk. No
error, no warning, and you would find out the next time you looked.

So photographs are keyed `(user_id, sku_id, side)` in `card_photos`, with `side` in
front/back. Four decisions:

- **Keyed on the SKU, not the holding.** The obvious key is the holding — your physical copy
  *is* a holding row. But selling a card deletes the holding, and a cascade would destroy the
  photographs at the moment they become most useful: a dispute, a return, a buyer asking to
  see the back again. `holdings` is already `UNIQUE (user_id, sku_id)`, so the same pair is
  one-to-one with the holding while it exists and outlives it afterwards. The cost, recorded
  rather than discovered: two copies of the same SKU share one pair of photographs.
- **Files on the host, not in the database and not in a volume.** `docker compose down -v`
  deletes volumes, and it is a command people run when something is stuck. Photographs of
  physical objects are the only data here that cannot be regenerated — comps can be
  re-ingested, prices recomputed, the checklist re-seeded. A bind-mounted folder survives
  every compose command and opens in Explorer. The price is that it needs its own backup,
  which is why `tools/backup.ps1` gained a verified photo zip in the same change rather than
  afterwards.
- **Read shared, write owned.** Anyone signed in can see anyone's photographs — helping a
  friend identify a card is the point. Only the owner can replace or delete, checked against
  the row's `user_id`. The UI does not render a Remove button a visitor cannot use; a button
  that always 403s is its own kind of broken, which is why that assertion is a browser test.
- **`/api/img/:skuId` became `private` and `Vary: Cookie`.** Once the card image depends on
  who is asking, `public, max-age=86400` is not a caching tweak but a correctness bug: a
  shared cache in front of the app — and there is one, the Cloudflare tunnel — could store
  one person's photograph under that URL and serve it to the next person. The placeholder's
  lifetime dropped from a day to two minutes for a smaller reason: a placeholder is precisely
  the response about to stop being true, and caching "no photo yet" for a day makes the
  feature appear not to have worked the first time you use it.

One naming lesson, cheap to state and expensive to find: the photo strip's CSS was written
against `.shot`, which was **already** the card-tile artwork class. The existing
`aspect-ratio:250/350` clipped away the caption holding Retake and Remove, and the new rules
silently restyled every tile in the gallery. In a single-file front end a generic class name
is a collision waiting for a second feature; it is `.ownshot` now.

## Card type, and which box it came from

Two derived fields live on `sku_detail`, computed in SQL rather than stored:

- `card_type` — the set-level category: Base, Base Optic, Insert, Autograph, Dual
  Autograph, Promo, Custom.
- `variant_type` — the copy-level category: Raw base, Parallel, Numbered /N, One of
  one, Graded, Graded parallel, Graded 1/1.

Deriving them means they can never disagree with the underlying parallel and grade
columns, which is what happens the moment a "type" is a free-text field someone
types.

Box provenance is deliberately two separate things, because they answer different
questions:

- **What the product says.** `product_boxes` holds each configuration (packs per
  box, cards per pack, guaranteed hits) and `box_contents` maps sections — and
  optionally specific parallels — to the boxes they appear in.
- **What you recorded.** `holdings.box_id` and `holdings.acquired_from` capture where
  *your* copy came from, which is the half that lets "value by box" tell you whether
  hobby boxes actually out-returned blasters.

`box_contents.availability` distinguishes `exclusive` from `reported_exclusive`, and
`product_boxes.verified` marks whether a configuration was corroborated. Kaboom is
the case that motivated this: one source calls it a hobby-exclusive short print and
the checklist sources don't restrict it. "Hobby exclusive" is a claim you make to a
buyer, so the app labels it as reported rather than asserting it.

## Adding cards you actually own

`src/collection.ts` handles two jobs that look like one:

`resolveOrCreateSku` turns a (card, parallel, grade) triple into a SKU, **creating
the parallel if the checklist doesn't have it**. Checklists are incomplete, and
refusing to record a card you're holding is worse than carrying an extra parallel
row — so a named-but-unknown parallel is added as user-declared, with its print run
parsed out of the name.

`createCustomCard` builds an entry for anything outside both products, under a third
product code `X`. It gets `is_custom = true`, which keeps it out of the reference-data
uniqueness constraint (you might own two different unnumbered promos) and lets the UI
mark it as yours. Its id is a content hash of its identity, so entering the same card
twice updates rather than duplicates. Everything downstream treats it identically to
a licensed card.

Own photos take priority over harvested ones and are never overwritten by the
harvester — a picture of the card in your hand is better evidence than a stranger's
listing. Uploads are validated by **magic bytes, not the declared content type**,
since a file input will happily hand you a renamed executable.

### Bulk entry: reuse the matcher, then refuse to trust it

`src/collection/quickAdd.ts` exists because the per-card form is the reason a collection
never gets entered. A thousand cards through a form with eight fields is not a data-entry
problem, it's a reason to give up.

The insight is that the hard part was already built. `resolveListing` matches messy eBay
titles — surname only, wrong order, missing set name, stripped accents — to a checklist row,
and it is the most heavily tested thing in the codebase. Somebody typing from a stack of
cards produces input of exactly that shape. So entry reuses the matcher instead of
demanding a tidy form, and the file adds only the two things a listing title never carries:
**how many you have** and **what you paid**. Both are stripped before matching, because
leaving them in actively misleads the parser — `x2` looks like nothing and `4.50` reads as a
card number.

Quantity and price are anchored to a symbol or a word (`x2`, `@4.50`, `paid 8`). A bare
number is never taken as either: `214` is Gilberto Mora's card number, and guessing wrong
there attaches a holding to the wrong card, silently and permanently.

**Parsing and committing are separate HTTP calls, and that is the design.** A matcher that
is right 90% of the time is excellent for pricing — a wrong comp gets excluded and the
median absorbs it — and unacceptable for data entry, where a wrong holding is invisible and
compounds. So `POST /api/collection/parse` reads and writes nothing, returns per-line
confidence, method and alternatives, and the human confirms. The commit reads the dropdowns
and number boxes out of the DOM rather than the parsed object, because otherwise the review
step is theatre.

#### The off-checklist parallel, which is most of the point

The first version resolved to SKUs only, which meant `yamal base blue /49` came back
unmatched. A SKU for a numbered parallel only exists if the parallel is on the checklist —
and the cards a collector most wants recorded are precisely the ones most likely to be
missing from it. Strict SKU matching therefore accepted the base cards and rejected the
valuable half of the shoebox: exactly backwards.

The card, though, is never in doubt — the line names a player and a section that both exist.
So when no SKU resolves, `cardCandidates` offers up to six *cards*, and committing one goes
through `resolveOrCreateSku` with the typed parallel and print run, which declares the
parallel and logs that it did. Three details make it safe rather than convenient:

- The picker **starts blank**. Choosing creates a SKU, so it has to be a decision somebody
  made, not a default they scrolled past. The commit count follows the pickers, because the
  number on the button is a promise about what will be written.
- The row is labelled with what will be created (`will be added as Blue /49 — new parallel,
  not on the checklist`), so declaring a parallel is never a side effect.
- The name is normalised to checklist spelling: hints come back in match order, so
  `blue holo` arrives as `["holo","blue"]`, and a parallel stored as "Holo Blue" could never
  be reconciled with a checklist that prints "Blue Holo".

Ordering of the candidates puts the matcher's own pick first (it got there with more evidence
than a name trigram), then an exact card-number match, then an exact section match, then name
similarity, then card id — exact section before similarity because a typed `base` should not
be answered with `Base Optic`, and card id last so the same paste always offers the same
order. The typed card number is in the `WHERE` clause and not only the `ORDER BY`: leaving it
out of retrieval meant `#91 ronaldo <noise>` scored 'Cristiano Ronaldo' below the similarity
floor and confidently offered a *different* Ronaldo.

#### "Nothing has been saved yet" was not true

The caption under the commit button said nothing had been written. It was wrong, and the way
it was wrong is worth keeping.

`resolveListing` **creates** the SKU it matches. That is correct for ingest — a sale on a
parallel nobody has recorded still has to be storable, and the alternative is dropping real
comps — and it includes an `Unidentified /N` parallel row when a numbered card's colour word
is unrecognised. Bulk entry called `resolveListing` directly. So parsing a paste inserted
`skus` rows, and a typo like `#91 ronaldo mango sorbet /37` permanently invented a parallel
in reference data. Typing something and clicking nothing left rows behind.

The fix is `ResolveOpts.createMissingSku`, defaulting true so every existing caller is
unchanged, with a read-only twin `lookupSku` that finds a SKU or returns null and never
inserts. Three details:

- The mode is resolved **once** into a local `toSku` binding rather than checked at each of
  the accept sites, so an accept path added later inherits the guarantee instead of quietly
  escaping it.
- Parallel matching is now shared between both modes (`bestParallel`) rather than duplicated.
  If they disagreed about which parallel a title means, review would show one card and commit
  would write another — a difference nobody would ever notice.
- Read-only mode returns `cardId` and `wouldCreateSku`, because "no SKU exists" must not
  degrade into "no idea what this is". The card is still identified; only the decision moves
  to the human.

`tools/check-parse-readonly.mjs` pins it, and the probe is deliberately a line that *matches
a card confidently* while naming a parallel that cannot exist — a probe that fails to match
would prove nothing, since the write happened on the accept path. It also asserts the row is
still usable: the card is offered and the parallel warning is present.

#### A print run with no colour word is still not the base card

Found while writing that probe. `resolveOrCreateSku` only created a parallel when it was
*named*, so `{cardId, printRun: 37}` — what you get from an unrecognised colour on a numbered
card — recorded the **base** card and discarded the /37. The worst kind of bug: silent,
permanent, and it prices a numbered parallel off base comps. `resolveSku` had already solved
this for ingest with `Unidentified /N`; both entry paths now agree, and the review row shows
the fallback name so the warning matches what is actually written.

The commit prices what just landed, sequentially. A 200-card paste firing 200 concurrent
valuations is how you exhaust the connection pool on the machine you are typing into. A
valuation failure is caught per card, because losing the holding to save the estimate is the
wrong trade.

## Player-first information architecture

The collection is presented by person, not by card. Owning four Lamine Yamals across
versions produced four near-identical tiles; one tile with his face and
"4 versions · A$11.2k" carries more information in less space, and drilling in gives
you the per-version detail that the grid was wasting room on.

`/api/players` aggregates per player — versions owned, quantity, value, the most
urgent action across everything you hold of them, blended trend. `/api/players/:name`
returns three things: who they are (with portrait attribution), every version you own,
and the base cards of theirs you *don't* own with current prices. That last list is
the same query a want-list would need, so it comes for free.

Both grid modes share the tile and row components, so pricing provenance, action
pills and box origin render identically whichever way you're looking at the
collection.

## Portraits, and one design mistake worth recording

Full details in `docs/PORTRAITS.md`. Two things belong here:

**The occupation check is load-bearing.** Resolving a name straight to its first
Wikidata hit puts a musician's face on a footballer's card, confidently and silently.
The P106 claim is the cheap discriminator, and the test suite covers a search that
deliberately returns the wrong person first.

**Full-bleed portraits were wrong.** The first version filled the whole card with the
face. It looked good in isolation and destroyed the feature it was built alongside: a
Kaboom starburst and Optic refractor bands both vanished behind the portrait, so every
version of a card looked identical again. Real cards frame the photograph inside the
set's design, and that is what it does now — inset window, artwork visible around it.
Caught by rendering a contact sheet and looking at it, not by reading the code.

## The default avatar: nation kits, not initials

A portrait can't always be found — the licence is unclear, the player is too new to
have a free photograph, the lookup is queued. The fallback still has to be a *picture*,
because a grid of 180 monogrammed circles is a table wearing a costume.

So the fallback is a head-and-shoulders silhouette on the player's national kit
colours and pattern: `nation_kits` holds a primary and secondary hex plus one of
`solid | stripes | checks | halves` for 56 nations. Argentina reads as sky-blue
stripes, Croatia as red checks, the Netherlands as orange, Qatar as maroon. About a
kilobyte of SVG each, generated in-process, no model and no rights question. Rows
carry `verified`; the ten unverified ones are best guesses and say so, and a nation
with no row at all falls back to a hash-derived neutral tint rather than asserting a
colour it doesn't know.

One bug worth recording: on Croatia's checks and Paraguay's stripes the silhouette
disappeared, because a semi-transparent dark figure over a two-tone high-contrast
field has no consistent edge anywhere. Fixed with a contrast rim stroke chosen from the
background luminance — white rim on dark kits, near-black on light ones. Same lesson as
the full-bleed portraits: found by generating a 12-nation contact sheet and looking at
it.

### Poses, and the rule that stops them lying

Position picks one of eight faceless SVG pictograms (`src/media/poses.ts`). The rule
that matters is the fallback: an unknown position draws the neutral standing figure, it
does not pick something plausible. A defender rendered diving reads as data, and wrong
data is worse than an obvious absence — the same principle as refusing an ambiguous
comp rather than guessing at it.

Position resolves `manual > wikidata > seed`, and the Wikidata read (P413) matches on
the referenced item's **label**, not on a hardcoded QID. Position QIDs are easy to
misremember, and a wrong id fails silently — one extra API call buys a mapping you can
check by eye. Most of the squad has no position and that is the intended steady state.

## Rarity is an effect layer, not different art

Scarcity is drawn as CSS over the artwork: one class per tier, keyed off print run,
parallel name and grade. Base is plain, an unnumbered parallel gets a slow sweep, gold
a warm refraction, /50–/199 a brighter sweep, /26–/49 cracked ice built from hard-stop
gradients, /25 and under animated foil plus a parallax tilt, a 1/1 the same with a
breathing rim, and any graded card adds a glass highlight on top of its tier.

Three decisions worth recording:

**Print run outranks the colour word.** A Gold /10 is a /10. The number is a fact about
scarcity; the colour is a label a manufacturer chose.

**One function, three surfaces.** `rarityTier()` serves the gallery tile, the
player-page row and the detail hero. Two copies of this logic would drift, and the
symptom — a card that looks rarer in one view than another — is the kind of bug nobody
reports and everybody distrusts.

**Effects are cheap on purpose.** No texture files, no per-parallel renders, so adding
a parallel costs zero assets. The foil is masked away from the centre because at full
bleed it erased the card underneath, which is the full-bleed portrait mistake repeating
itself one layer up. There is a manual off switch, and `prefers-reduced-motion` turns
everything static without it.

### Every rung adds a cue; no rung removes one

The bands sit where collectors already put them — /99, /49, /25, /10, 1/1 are the
numbers printed on the cards — and each rung *keeps* the cues below it and adds one.
Different-but-not-more reads as "another variant"; more-plus-one-new-thing reads as
"rarer". Unnumbered parallels are a flavour, not a rung: an unnumbered Gold renders at
the same intensity as an unnumbered Purple and differs only in hue, because it is not
scarcer than a /99.

### The hierarchy is a test, not an opinion

`tools/verify-hierarchy.sh` freezes the animations at a fixed phase, screenshots each
rung, and measures luminance change, colourfulness and gradient energy against the base
tile. It asserts the composite score rises monotonically **and rises with colour removed
entirely** — a ladder that only ascends in hue does not exist for a deuteranope. It runs
at both grid sizes, under reduced motion, and with effects off, where it asserts
flatness instead of ordering.

Writing the test was worth more than the design work it verified. It found an unnumbered
Gold parallel outranking a /99, a /25 measuring weaker than a /49 (foil had *replaced*
the fracture lines rather than joining them — that is where the add-never-swap rule came
from), a reduced-motion fallback that clipped the top three rungs to the same white, and
— most embarrassing — a harness that was scoring the sample *labels*, because the
captions sat over the artwork and text is nothing but high-contrast edges.

## Shadow mode: scores describe, arithmetic decides

The three scores are **not** wired into the sell/hold decision, and that is a deliberate
refusal. `market_score > 72 → hold` cannot be argued with; `argmax(EV_sell_now, EV_hold,
EV_grade_then_sell)` can. Someone who disagrees with a 55-day half-life can change it to
40 and watch HOLD become SELL, which is worth more than any single number that happens to
be well-calibrated.

But the scores are not wasted either. `src/valuation/shadow.ts` writes one row per SKU per
day into `decision_log`: the action, the arithmetic behind it, and the scores alongside.
`observeOutcomes()` fills in the median comp price 30 and 60 days later. `evaluate()` then
asks whether a score frozen at decision time predicted what happened after it.

Three rules that keep that honest:

**Forward returns only.** Asking whether a high market score correlates with today's price
is circular — the score is *made of* price. The only non-circular question is whether it
predicted the next 30 days.

**Independent situations, not rows.** Twenty sales of one Yamal parallel is one market
situation sampled twenty times. The gate counts distinct player × rarity groups, and with
12 logged decisions and zero forward observations the endpoint says `insufficient` and
tells you not to touch the weights. That is the correct output, not a failure.

**Promote the variable, not the score.** If market score turns out to predict +8% over 30
days, the thing to add to the forecast is whatever produced it — momentum, sell-through,
comp velocity — not `if market_score > 75: hold_bonus += 10`. A score is a presentation
artefact; a validated component is a model input.

The weights are stamped `heuristic-v1` with `calibrated = false` in every row. Retuning
them each time three sales land would be worse than leaving imperfect weights alone, and
without the stamp you could not tell which guess produced which row.

One exception, taken now rather than later: **evidence quality already affects
recommendation confidence.** "SELL — 2 comparable sales" and "SELL — 25 comparable sales"
are not the same claim and never were.

## Post-tournament decay: baseline plus hype, not a longer half-life

    P(t) = B + H · exp(-t / τ)

The intuition that a /10 holds better than a base parallel is sound. Encoding it as a
longer half-life is not: there is no evidence for rarity-specific decay *rates*, and there
is a confound that would manufacture the appearance of one. A /10 trades once every six
weeks, so a flat price line may be an absence of observations rather than stability.
**Illiquidity masquerades as price stability.**

So scarcity does not touch τ. Player tier owns τ (30/55/75-day priors, from previous
cycles, marked as priors). Scarcity and card archetype own **H** — how much of today's
price was hype in the first place. A base Yamal at A$100 might be A$55 baseline and A$45
hype; a /10 at A$800 might be A$700 baseline and A$100 hype. Identical decay rate, and the
/10 still loses far less of its total value. The claim gets weaker and the arithmetic gets
the same answer, which is the trade you want.

What scarcity *does* get is a wider error bar: `retain90Range` widens with both scarcity
and thin trading, because a card that trades quarterly gives the projection almost nothing
to stand on.

## Grade population: a fourth axis, kept out of condition

A PSA 10 is condition. A PSA 10 out of 40 graded is a different card from a PSA 10 out of
4,000 — but that is *population context*, and `psa_population` is a separate table for the
same reason it is a separate meter in the UI. `conditionScore()` takes no population
argument at all, and a test asserts that passing one changes nothing.

Two refusals in `src/sources/psa.ts`:

**No value bonus for a low population.** A population of 3 can mean rare, unpopular, too
new, not worth grading, or that owners prefer BGS. Only market evidence separates those,
and market evidence has its own axis.

**No scraper.** PSA publishes a population endpoint on its public API; with a token it
works, without one every card reads "not checked" and you can type the figures in by hand.
A scraper that breaks silently and fills the table with plausible nonsense is worse than
an honest gap. Coverage is meant to be partial — the valuable cards and the grading
candidates.

## Three scores, never one

`src/valuation/scores.ts` reports **rarity**, **condition** and **market** separately and
never sums them. A single `cardScore` is the idea that feels clever and then ruins the
tool: when it moves you cannot tell whether the card got scarcer (impossible), the copy
got nicer (impossible without regrading), or the market moved — the only one that ever
actually happens.

Two invariants, both tested:

- **Rarity is a pure function of print supply.** No price, no comps, no trend, no player
  form. A /49 does not become scarcer because its player scores in a final.
- **Market never reads the print run.** Price already contains the market's own opinion
  of scarcity; feeding the run in as well double-counts it and makes a falling /10 look
  healthy.

Details that matter more than they look:

**A raw card is unknown, not average.** Condition returns `display: 'absent'` for an
ungraded card so the UI can draw a hatched bar and the words "not assessed" rather than a
half-full one. "We have not assessed this" and "we assessed this as middling" are
different claims and only one is true. Market, by contrast, always *has* a figure even
from a seed — so it shows the number and labels the basis. Printing "not assessed" over a
real estimate because it wasn't comp-backed conflated two different questions, and did so
on screen for a while.

**Value is placed on a log scale within the product.** Linear, one A$24,000 Messi flattens
every other card in the collection to zero and the axis stops describing anything.

**Grade tables are per grader.** A BGS 9.5 is gem mint and outranks a PSA 9; a PSA 9.5
does not exist. One curve for both would quietly invent grades.

**The bands live twice, and a test proves they agree.** TypeScript owns them for the API;
the dashboard has an inline copy so a tile can pick its effect class without a request.
`test/rarity-parity.test.ts` lifts the browser function out of `web/index.html`, runs it,
and compares both across every boundary and either side of it. Two copies of a rule drift,
and the symptom — a card that looks rarer than it scores — is the kind of bug nobody
reports and everybody quietly distrusts.

## Geography: what can be measured, and what can only be linked

The request was a Melbourne heat map plus Facebook Marketplace and Google search per card,
and whether a card is trending in Europe or China. Three of those four are buildable and one
is not, so the design says which is which rather than blurring them.

**Not buildable, and not attempted.** Facebook Marketplace has no public listing API,
requires a logged-in session, and publishes asking prices rather than sales. Scraping it
means driving a browser with the user's own credentials against Meta's terms — risking the
account they sell from — to collect numbers that are not comps. Google organic results have
no free API and Trends has no official one at all. So `src/search/links.ts` fetches nothing:
it builds URLs, grouped and annotated, and the human clicks. That is a deliberate ceiling.
The alternative is a scraper that breaks silently and fills the database with asking prices
dressed as sales, which corrupts every valuation downstream.

Every link carries a note saying what it actually yields, and a test asserts that the
asking-price channels admit it — that is the one thing a user could get badly wrong.

**The query is short on purpose.** Marketplace search engines do token matching, so
"2025-26 Donruss Road to World Cup Gilberto Mora #214 Rated Rookie Teal /199 PSA 10" matches
nothing anybody ever wrote. Player plus the two or three distinguishing tokens finds cards;
the long form is offered separately for when the short one returns a mess. And every eBay URL
carries `LH_Sold=1&LH_Complete=1`, because reading asking prices is the most common way a
collector talks themselves into a valuation.

**Buildable, and measured: demand by region.** `regional_demand` aggregates comps per
marketplace, net of that venue's fees and price realization, and `/api/regions` expresses
each region as a percentage against the home market rather than a global average that
includes the region being compared. Every row reports `n_comps` and a confidence word:
under three sales it is labelled a one-off and drawn in a muted colour, because a region
with one sale has told you nothing. This is the honest answer to "is it hot in Europe" —
what it sold for there, not how often it was searched for.

**Buildable, but coarse: seller location.** eBay's Browse API returns `itemLocation` with a
country, usually a state and sometimes a city. Only the country was being stored; city and
state are now kept, since they are the finest grain any source provides. `/api/geo` reports
the split *and the coverage* — how many comps carry a location at all — and warns below 60%,
because a map built from a third of the data is a map of that third. It is also explicitly
the seller's location, not the buyer's: for demand, use the regional view.

**A Melbourne-suburb heat map is not possible** from any accessible source, and inventing
that precision would be worse than not having it. What is possible is manual: the CSV
importer now accepts `city`, `region` and `country`, which is the only path by which a sale
at a Melbourne meet or in a Facebook group ever enters the model at all. Those sales exist in
no API — if they are not typed in, the local channels can never be evaluated against eBay,
which is precisely the comparison a Melbourne seller needs.

## Nation, position, club: three slices, three provenances

Nation is free: these are World Cup products, so `cards.team` is the country. Position
and club live on the player, are nullable, and carry a `_source` column, because they
have very different reliability and the UI has to be able to say so.

Club is the interesting one. Panini prints the national side, not the employer, so the
checklist has no club data at all — it comes from Wikidata P54 or by hand, and it is a
**snapshot**. P54 is a career history, so the current club is the statement with no end
date (P582), preferring a `preferred`-ranked open statement and ignoring deprecated
ones. When two statements are still open — overlapping loans, or a page mid-edit — it
stores nothing. A club filter that silently shows last season's squad is worse than one
that admits it doesn't know, and "nothing" is recoverable where "wrong" is not.

Both filters expose an explicit "unknown" option rather than hiding that bucket, and the
dropdown counts are SKUs — the unit the gallery actually renders — so "Real Madrid (32)"
shows 32 tiles. Counting cards there was a real bug: it promised 31.

### Staleness changes what we claim, not what we show

The tempting move is to hide the club filter once the data ages. It is the wrong one: a
Chelsea option that exists today and vanishes tomorrow because a threshold elapsed reads
as a broken app, and the underlying information didn't stop being useful — its
*confidence* dropped. So freshness drives presentation only:

- under 45 days, the club is stated plainly on the tile
- past that, the tile appends "may be outdated" with the age in the tooltip
- the exact date, source, resolution and revision live on the player page, and a
  breakdown by freshness bucket lives under Data & sources

`club_checked_at` alone only says when *we* looked. `club_revision` records the Wikidata
entity revision we read, which is the thing you actually want when a club turns out wrong
and the question is whether upstream changed or our parse was at fault.

CardVault does not rely on generated likenesses of real footballers. Real-player
portraits come from appropriately licensed photographic sources; generated artwork is
restricted to anonymous, non-identifiable football figures, poses, textures and visual
effects. That split is what keeps identity in the database and art in the renderer —
see `docs/PLAYER-ART.md`.

## Charts

Hand-rolled, no chart library, no CDN — it works offline. The palette is the
validated default instance: six categorical slots clearing every gate against this
dark surface (worst adjacent CVD ΔE 8.4, worst adjacent normal-vision ΔE 19.3, all
≥ 3:1 contrast). Status colours are reserved and always paired with a glyph and a
word, so an action is never communicated by colour alone.

Two mistakes are recorded here because both were invisible until the page was
actually rendered and looked at:

- **Text inside a non-uniformly scaled SVG is unreadable.** A `viewBox="0 0 100 H"`
  with `preserveAspectRatio="none"` gives exact percentage bar geometry with no
  measuring — and stretches every `<text>` inside it by the container width into a
  smear, and every `<circle>` into an ellipse. All bars are now HTML/CSS
  (percentage widths, real type, trivial hover); the line chart keeps the stretched
  SVG for its path only, with the dots and all labels as HTML positioned over it.
- **A CSS variable that doesn't exist fails silently.** `CSS('--seq-550')` returned
  an empty string and the legend swatch simply rendered blank — no error, no warning.
  There is now a check that every referenced custom property is declared.
- **Tooltip HTML must be attribute-escaped.** The tip content is real markup
  injected into `data-tip="…"`. An inner `class="tn"` closed the attribute early
  and dumped raw HTML onto the page as visible text. `tipAttr()` neutralises quotes.

Bars are plotted in strict value order. The recommendation engine additionally
penalises venues you can't practically use, but a bar chart whose bars aren't in
value order just reads as broken — so viability is carried by colour and the legend,
and the axis stays honest.

## The dev override's node_modules volume, recorded because it cost three runs

`docker-compose.override.yml` mounts `- /app/node_modules` so the host's `node_modules` cannot
shadow the container's — the standard fix for mounted Node containers, since host modules are
built for a different platform. It is an **anonymous volume**, which is the part that bites.

Docker creates that volume once, populated from the image, then reuses it for the life of the
container. It therefore *masks* the `node_modules` of every image built afterwards. Adding
`@fastify/cookie` and rebuilding produced, three times in a row:

```
Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@fastify/cookie' imported from /app/src/server.ts
```

Two things made it hard to read:

- **The container reported `Up`.** `tsx watch` survives the crash and keeps restarting the
  process, so `docker compose ps` showed `Up 23 minutes` while nothing was ever served. The
  only reliable liveness check is an HTTP request, not container state.
- **`curl -s` hid the cause.** `-s` suppresses connection errors, so a refused connection
  prints exactly the same thing as an empty successful reply: nothing. `curl -i` says
  `Connection was aborted`, which is the actual diagnosis.

`restart`, `up -d`, and `down` + `up` all preserve the volume. What does not:

```bash
docker compose build api worker
docker compose up -d --force-recreate --renew-anon-volumes api worker
```

Scoped to `api worker` because the database is a *named* volume and must not be caught up in
it. `down -v` would delete the database — never reach for it to fix this.

The rule the override buys you is therefore narrower than "never rebuild": **source edits and
new .sql files are free; a new npm package costs one volume renew.** The note now lives at the
top of the override file itself, where somebody adding a dependency will actually read it.

## One Windows encoding trap, recorded because it cost a run

`setup.ps1` is plain ASCII with a UTF-8 BOM, and both halves of that matter.

Windows PowerShell 5.1 decodes a BOM-less `.ps1` as Windows-1252. A UTF-8 em dash is
`E2 80 94`, and in that codepage the last byte is a **right smart quote** — which
PowerShell accepts as a string delimiter. So one em dash inside a double-quoted string
closed the string early, every quote after it was off by one, and the parser finally
complained about an unrelated `&` thirty lines further down. The error points nowhere near
the cause.

Two defences, both applied: the file contains no non-ASCII at all, and it carries a BOM so
any future non-ASCII is decoded as UTF-8 regardless. Same reason `.env` and `.env.example`
were de-dashed — they were only comments, but they are read by Windows tooling too.

**A second 5.1 trap, from the same run.** PowerShell wraps anything a native command writes
to stderr in an `ErrorRecord`, and under `$ErrorActionPreference = 'Stop'` that record is
*terminating*. So `docker info` failing produced a raw `NativeCommandError` and never
reached the friendly message two lines below it — and `docker compose up`, which writes
ordinary build progress to stderr, was the same trap waiting on the happy path. Every
native call now goes through an `Invoke-Native` helper that drops to `Continue` for the
duration and returns the exit code. The script also offers to start Docker Desktop and
polls the engine for three minutes, because "installed but not running" is the most common
way a first setup fails and it is fixable without leaving the terminal.

## One job, registered twice, logged never

The startup log listed seven scheduled jobs and `alerts` was not among them, which looked
exactly like a feature with a rules engine, a job handler, an API endpoint and a dashboard
panel that nothing ever triggered.

It was wrong. Alerts *were* scheduled — by a second, hardcoded `upsertJobScheduler` call
after the loop, hourly at :20, which never logged anything. The absence in the log was the
only symptom, and it pointed at the wrong conclusion.

Two real problems underneath, both now fixed:

**Registration in two places.** Adding a `CRON_ALERTS` config value put a second
registration under the same key. `upsertJobScheduler` is last-write-wins, so the config
value would have been silently overwritten by the hardcoded pattern — a setting that reads
correctly, parses correctly, and does nothing. Every schedule now comes from one list.

**A job that does not announce itself is invisible.** The loop logs `{key, pattern}` per
entry; the hardcoded call logged nothing, so the only way to know it existed was to read
the file. Startup logging is not decoration here — it is the only place the *effective*
schedule can be observed, and an incomplete list is worse than none because it invites
exactly the wrong fix.

The schedule the worker had been running all along is preserved: hourly at :20, now via
`CRON_ALERTS`.

## The install path is a test too

`migrate` then `seed`, on an empty database, is the one code path that is easy to never
run again after the first week — and it had a real bug sitting in it. `players` is derived
from the checklist, and the derivation lived in migration 006. Migrations run *before* the
seed, so on a fresh install `cards` was empty when that INSERT ran, it inserted nothing,
and the whole player-first collection view came up blank. The name-matched position and
club seeds failed the same way for the same reason.

They now live in `db/seeds/positions.sql` and `db/seeds/clubs.sql`, applied by `npm run
seed` after the cards are in, and idempotent so re-running is free. The migrations keep the
DDL only.

Verified from scratch: 1,771 cards, 1,771 base SKUs, 160 parallels, 783 players, 56 nation
kits, 38 seeded positions, 38 seeded clubs, and the facet endpoint reporting 57 teams, 6
positions and 19 clubs.

One number that was simply wrong: the seed logged 164 parallels because it counted
insert *attempts*, and `parallels.json` lists a few names under more than one section. The
table has always held 160. It now logs the row count.

## Testing

`npm test` — 37 unit tests over the parts where being wrong is expensive and silent:
title parsing, robust statistics, the SQL guard, and the decay/gem-rate economics.

`npm run smoke` — the whole pipeline against synthetic listings, no external calls.
It prints every match decision with its method and confidence, so a matching
regression is visible rather than silent. It found five real bugs on first run; that
is what it's for. Run it after any change to matching or pricing.

`npm run verify:art` — asserts that each version renders as distinct bytes and that
the add dialog's live preview actually changes, because "the picture updates" is
exactly the kind of claim that is easy to believe and wrong.

`npm run verify` — boots the API, probes the endpoints whose output is easy to get
subtly wrong, then screenshots every tab with Playwright. The layout bugs above were
found by looking at those screenshots, not by reading the code; a colour validator
checks colour, not geometry.
