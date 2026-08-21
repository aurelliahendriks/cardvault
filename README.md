# CardVault

Server-side price intelligence and sell-routing for FIFA World Cup 2026 trading cards.

Grew out of a single-file HTML tracker: 1,771 hardcoded cards with hand-seeded AUD
estimates. Those estimates were a good prior but a frozen one, and a checklist can't
tell you *where* or *when* to sell. This replaces the frozen part while keeping
everything the tracker got right.

## What it actually does

**Tracks prices from live market data.** Pluggable sources in preference order:
eBay's official Marketplace Insights API (real sold comps) → Bright Data scraping
of eBay sold pages → free self-hosted scraping → manual CSV. It walks the list and
stops at the first source that produces enough comps, so paid requests are spent
only on cards the free tiers couldn't cover.

**Matches messy listings to your checklist.** A deterministic title parser handles
grades, serial numbers, parallels, sections and hard rejects (lots, breaks, sealed
product, sticker albums, reprints). Trigram + `word_similarity` matching catches
surname-only titles and accents. Only genuinely ambiguous titles cost an AI call.
A wrong match corrupts a price permanently, so the default on uncertainty is to
reject the comp and say so.

**Prices robustly on thin data.** Card comps are the worst case for a naive
average: n is often 3–8, one buyer overpays 4×, and one mismatched listing moves a
mean by 200%. Median centre, MAD outlier rejection with a ratio fallback for when
half the sales are at an identical price, and recency weighting with a
player-tier-dependent half-life.

**Tells you where to sell, in net AUD.** Comparing headline prices across
marketplaces is misleading. The model subtracts final value fees, the 1.65%
international surcharge, postage from Australia, and demand drag from buyer-side
import duty — then applies each venue's *price realization* and value band. That
last part matters: a local shop looks like a fee-free 100% sale until you encode
that shops pay 40–60% of market.

**Tells you which community to sell to.** Separate question from "which
marketplace". A A$3 base Yamal is a postage loss on eBay and a fine sale inside a
player lot on Whatnot. Mexico squad cards clear *above* global price in Mexican
Facebook groups. Channels are scored on fit — section, nationality, value band,
lot-friendliness, speed — not just price.

**Models the post-tournament clock.** The 2026 final was 19 July. Non-icon cards
historically give back 20–40% over the following months; icons barely move. The model is
`P(t) = B + H·e^(-t/τ)`: a collector baseline plus an event premium that decays. Player
tier sets τ — how fast hype leaves. Scarcity sets *H* — how much of today's price was hype
at all — rather than bending the curve, because there's no evidence that rare cards decay
more slowly and there is a confound that would fake it (a /10 trades once a quarter, so a
flat price line may be missing data rather than stability). Same decay rate, and a /10
still loses far less of its value. Scarcity and thin trading widen the error bars instead. Grading verdicts are discounted by the decay
expected during the 4–8 months a card spends in the queue — the check most grading
calculators skip, and it flips a lot of verdicts right now.

**Shows you the cards, not a spreadsheet.** The dashboard leads with a card
gallery: image tiles carrying price, 30-day sparkline, provenance and the
recommended action, sized S/M/L, filterable by section, nation and value. There is
no card-image API for these sets — so the app harvests its own artwork from the
photos attached to matched sold listings, ranked by match confidence (a photo from
a shaky match might be a different card, and a wrong picture makes you misidentify
what you own). Anything without a photo yet gets a generated, section-coloured
monogram card rather than a broken-image icon, which matters because a cold install
has zero listings and 1,771 grey rectangles would be useless. Images are proxied
through a disk cache, so the gallery doesn't decay into dead thumbnails when
listings are deleted.

**Lets you add anything you actually own.** A card off the checklist goes in from
any tile or the detail panel, with the version (parallel, grade) and your copy
(quantity, what you paid, which box it came out of, condition) recorded together —
naming a parallel or grade nobody has recorded yet just creates it rather than
refusing the card. Anything the checklist doesn't cover goes in as a custom card:
another product, a missing entry, a promo, a sticker. Custom cards are priced,
valued and recommended identically to licensed ones. And you can upload your own
photo of your own copy, which outranks any harvested listing image and is never
overwritten by the harvester.

**Organised by player, not by card.** The collection leads with one tile per player,
carrying their photograph, how many cards of them you own and what they're worth.
Opening a player gives you their page: every version you hold with its price, type,
box and recommended action, plus what's still missing from the checklist with current
prices — which doubles as a shopping list. Photos come from Wikidata and Wikimedia
Commons, chosen because they carry machine-readable licensing; the occupation field is
checked so a same-named musician doesn't end up on a card, anything whose licence
can't be established is refused, and the author/licence/source credit is stored and
displayed wherever a portrait appears. See docs/PORTRAITS.md before republishing any
of it. Where no free photograph exists, the player still gets a picture rather than a
monogram: a silhouette on their national kit colours and pattern — Argentina's sky-blue
stripes, Croatia's red checks, the Netherlands' orange — for 56 nations, about a
kilobyte each, no model and no licence question. Where the position is known the figure
takes a matching pose from a set of eight (a keeper dives, a striker shoots, a
centre-back slides); where it isn't, it stands, because a guessed position looks like
data.

Every player's tile is *staged* differently — backdrop, accent, facing, scale, motion
tempo — all derived from the name, so two players in the same kit and position no longer
render identically: 523 distinct stagings across the 783 players on the checklist. What
never varies is anything about the person: no skin tone, no build, no face, because those
would be invented claims about real people. Icons and hot cards get rays and a warm rim.
And the avatars move — each pose has its own idle, whole-figure only, honouring
reduced-motion through the two channels that actually work for an `<img>`-loaded SVG (the
in-SVG media query is not one of them; that was a real bug, caught by comparing pixels
750ms apart). See docs/PLAYER-ART.md.

**Draws scarcity instead of listing it.** Eight rungs, and each one *adds* a cue to
the one below rather than swapping in different decoration: a parallel gets a faint
sweep, /100+ a brighter one with a corner glow, /50–/99 the same much brighter, /26–/49
adds cracked ice, /11–/25 adds a foil ring and a parallax tilt, /2–/10 a warm rim, a 1/1
a saturated foil that breathes. Graded cards add glass on top of whatever rung they were
already on. All CSS over the same artwork — no texture files, no per-parallel renders —
so print run drives the effect and the colour word doesn't (a Gold /10 is a /10, and an
unnumbered Gold sits level with an unnumbered Purple because it isn't scarcer than a
/99).

The ordering is a test, not a matter of taste: `tools/verify-hierarchy.sh` freezes the
animations, measures luminance, colourfulness and structure per rung, and fails if the
ladder isn't monotonic — including with colour removed entirely, so it still reads for
a colour-blind viewer. It runs at both grid sizes, under `prefers-reduced-motion`, and
with effects off. It caught a gold parallel outranking a /99 and a /25 measuring weaker
than a /49; both looked fine in review.

**Keeps the recommendation auditable, and the scores out of it.** Sell/hold/grade stays
explicit expected-value arithmetic — fees, postage, decay, grading queue, liquidity — so
you can disagree with an assumption, change a half-life from 55 days to 40, and see
exactly why HOLD became SELL. The descriptive scores never enter that arithmetic. They're
logged beside every decision instead, with the outcome filled in 30 and 60 days later, so
they can earn their way in by predicting something. Until there's enough data, the weights
are stamped `heuristic-v1`, flagged uncalibrated, and frozen — and Data & sources says so
in as many words, counting *independent* situations rather than rows, because twenty sales
of one parallel is one situation sampled twenty times.

**Scores rarity, condition and market separately.** Three axes, never summed. Rarity is a
pure function of print supply — a /49 does not become scarcer because its player scores in
a final. Market reads price, trend, liquidity and evidence quality but never the print run,
because price already contains the market's opinion of scarcity. Condition comes from the
grade, per grader, and an ungraded card reports "not assessed" rather than a middling score,
because an absence is not an average. PSA population is a fourth axis and stays out of
condition entirely — a PSA 10 out of 40 graded and a PSA 10 out of 4,000 are the same
condition and very different populations — and a low population never earns a value bonus
on its own, since it can equally mean unpopular, new, or not worth grading. There's no
scraper: set a PSA token, type the counts in by hand, or read "not checked".
A PSA 10 is emphatically *not* a rarity tier: it adds
glass over whatever rung the card was already on, and the hierarchy test fails if grading
ever pushes a card past the rung above it.

**Tells you where to look, and where it actually sells.** Every card has a search launcher:
one click each for eBay sold-and-completed across AU/US/UK/DE/ES/IT, Yahoo Auctions Japan,
MercadoLibre Mexico, Xianyu, Facebook Marketplace centred on Melbourne with a radius, VIC
Gumtree, and a Google Trends comparison across AU/GB/DE/CN. Nothing is scraped — Facebook
Marketplace has no listing API, needs a logged-in session and shows asking prices rather than
sales, so building the URL and letting you click is the honest ceiling. Each link says what it
actually yields, and the asking-price ones admit it.

Regional demand, by contrast, *is* measured: median sold price per marketplace region net of
that venue's fees and realization, expressed against your home market, with the comp count and
a confidence word on every row — under three sales it reads "one-off" rather than being drawn
as a trend. Seller locations from eBay are aggregated to country and state with the coverage
percentage shown, since a map built from a third of the data is a map of that third. Suburb
level does not exist in any source, so local sales get on the map the only way they can: the
CSV importer takes `city` and `region`, which is also the only way a Melbourne meet or Facebook
group sale enters the model at all.

**Slices by nation, position and club.** Nation comes free with the checklist. Position
drives the avatar pose as well as the filter. Club isn't in the checklist at all —
Panini prints the national side — so it comes from Wikidata P54 or by hand and is
labelled a snapshot, with an explicit "unknown" bucket rather than a filter that hides
the players it can't place. Staleness changes what the app claims, never what it shows: a
club past 45 days says "may be outdated" on the tile, the exact source, revision and check
date sit on the player page, and the filter never disappears — an option that vanishes
overnight reads as a bug, and the data didn't stop being useful, it got less certain.

**Shows the right picture for the version you picked.** Card artwork is generated
per version, so Base, Base Optic, Kaboom!, an autograph and a numbered parallel each
look different — Optic gets prismatic refractor bands, Kaboom a comic starburst, an
autograph a signature stroke, a numbered parallel a foil band with its print run, and
a graded card renders as a slab with the label. Parallel colour words drive the hue,
so a Gold /10 and a Teal /199 of the same card are distinguishable at a glance. In the
add dialog the artwork updates live as you change section, parallel or grade. Real
photographs replace the art as they're harvested; "Find a real photo" runs a targeted
search for one card on demand, and you can always upload your own.

**Tells you what kind of card it is and which box it came from.** Every card
carries a derived type (Base / Base Optic / Insert / Autograph / Dual Autograph /
Promo) and a version (Raw base / Parallel / Numbered /N / One of one / Graded), both
computed in SQL so they can't drift out of sync with the data. Box provenance is
tracked two ways: what the product's configurations say (Hobby 12×30 with a
guaranteed auto and memo, Blaster 6×15 with six Rated Rookies, Hobby International
with its exclusive Optic Argyle, Panini×Kayou Premium Hobby 10×6) and what *you*
recorded for your own copy. Claims that couldn't be corroborated — Kaboom being
hobby-exclusive, for instance — are labelled "reported" rather than presented as
fact, because that's a selling point you shouldn't make to a buyer unless it's true.

**Answers questions in English.** "What should I sell this week", "which Mexico
cards do I own", "how much of my portfolio is backed by real comps". The model
writes SQL; it never runs it — a whitelist, a static SELECT-only guard, and a
`READ ONLY` transaction with a statement timeout sit in between.

**Charts that don't lie.** Every figure carries its provenance, so estimates never
look like observed prices. The palette is the validated default from the data-viz
method (six categorical slots passing every colour-blindness and contrast gate
against this dark surface), status colours are reserved and always ship with a
glyph and a word so colour is never the only channel, and bars are plotted in
value order with viability carried by colour rather than by re-ordering the axis.
No chart library, no CDN — it works offline.

## Quick start

```bash
git clone <your-repo> cardvault && cd cardvault
cp .env.example .env          # nothing is required to boot
docker compose up -d
open http://localhost:8080
```

That gives you the full checklist, your collection, the net-proceeds calculator and
the community router, priced off the seeded estimates carried over from the HTML
tracker. Add credentials to `.env` to turn on live pricing:

| Want | Set | Notes |
|---|---|---|
| Live sold comps | `EBAY_CLIENT_ID` / `EBAY_CLIENT_SECRET` + `EBAY_INSIGHTS_ENABLED=true` | Marketplace Insights is a **limited release** — you must apply to eBay. Best data by far once granted. |
| Sold comps without Insights | `BRIGHTDATA_API_KEY`, `BRIGHTDATA_ENABLED=true` | Paid per request, capped by `BRIGHTDATA_MONTHLY_REQUEST_CAP`. |
| Supply / sell-through | `EBAY_CLIENT_ID` / `EBAY_CLIENT_SECRET` | Browse API is open — no application needed. Asking prices only. |
| Free fallback scraping | `SCRAPE_ENABLED=true` | Will get blocked. Circuit breaker opens for an hour after 3 blocks. |
| AI matching, NL search, written reasoning | `ANTHROPIC_API_KEY` | Capped by `AI_MONTHLY_BUDGET_USD`. |

Every AI feature degrades to a deterministic fallback when the key is absent. The
app never silently stops working because a credential expired — check
`/api/health/sources`.

### Typing cards in fast

**My collection → Paste a list of cards.** One card per line, written the way you would say
it out loud from a stack:

```
mora 214 x2 @4.50
messi kaboom psa 10
yamal base blue /49
#91 ronaldo teal
```

`x2` is quantity, `@4.50` or `$4.50` is what you paid, and everything else goes to the same
matcher that identifies eBay titles — so surname only, wrong word order, missing set name
and stripped accents all work. A bare number is treated as a card number, never as a price.

Nothing is written until you press the button. Every line comes back with what it matched
and how confident it was, because a matcher that is right 90% of the time is fine for
pricing (a bad comp gets excluded) and not fine for data entry (a bad holding is silent and
permanent). Three outcomes:

- **matched** — settled; the dropdown holds the other versions of that card if it is wrong.
- **check this** — either a weak match, or a numbered parallel that is not on the checklist.
  The second case is normal and expected for /49s, /25s and /10s: pick the card from the
  list and the parallel is created on commit, named the way the checklist names them.
- **no match** — skipped. Add the card number, or tick the AI box and check again.

Quantity and price stay editable in the review table, and what you confirm there is what
gets written. To check that claim rather than trust it:

```bash
node tools/check-parse-readonly.mjs   # asserts parsing changes no row counts (needs DATABASE_URL + a running API)
node tools/shot-bulk.mjs              # screenshots each state of the dialog into /tmp/shots
```

### Import an existing file

Data & sources tab, or:

```bash
# the .json save file from the old HTML tracker: quantities, price overrides, sales log
curl -X POST localhost:8080/api/import/legacy-json -H 'Content-Type: application/json' \
  -d @my-collection.json

# or the CSV export
curl -X POST localhost:8080/api/import/holdings-csv -H 'Content-Type: application/json' \
  -d "{\"csv\": $(jq -Rs . < collection.csv)}"
```

### From your phone

Same wifi works now — `http://<your-PC-IP>:8080`. For a real installable app, and for reaching
it away from home, see **[docs/REMOTE-ACCESS.md](docs/REMOTE-ACCESS.md)**: a Cloudflare Tunnel
gives you HTTPS with no router changes, and HTTPS is what "Add to Home Screen" requires to
install rather than bookmark.

Set `TRUST_PROXY=true` whenever anything sits in front of the API. Skipping it makes the login
throttle treat every visitor as the same client, so five wrong passwords lock out everybody.

### Backups

```powershell
.\tools\backup.ps1        # verified, rotated pg_dump into .\backups
```

## Running it

```bash
npm run migrate        # schema
npm run seed           # 1,771-card checklist + 160 parallels + 783 players + base SKUs
npm run ingest -- fx   # FX rates (free, no key)
npm run ingest -- hot  # poll held + hot + valuable cards
npm run revalue        # recompute valuations from comps
npm run recommend      # sell recommendations, highest stakes first
npm run ask -- "what should I sell this week"
npm run smoke          # full pipeline against synthetic listings, no API calls
npm test               # 37 unit tests
npm run portraits      # fetch player photos (or: -- --status, -- "Lamine Yamal")
npm run verify         # boot the API, probe it, screenshot every tab (needs playwright)
npm run verify:art     # assert each card version renders differently
npm run verify:players # assert the player view and portrait compositing work
```

The worker runs these on cron by default (`CRON_*` in `.env`): FX daily, hot cards
every 4h, full sweep nightly, revalue and recommend after that, alerts hourly.

## Architecture

```
   sources/            ingest/            match/             valuation/         recommend/
┌──────────────┐   ┌────────────┐   ┌───────────────┐   ┌──────────────┐   ┌──────────────┐
│ ebay_insights│──▶│ query      │──▶│ titleParse    │──▶│ stats        │──▶│ timing       │
│ brightdata   │   │  ladder    │   │  (free)       │   │  median+MAD  │   │ venue        │
│ self-scrape  │   │ persist    │   │ trigram/word  │   │  recency wt  │   │ community    │
│ sportscardspro│  │ dedupe     │   │  similarity   │   │ fallback     │   │ grading EV   │
│ csv_import   │   │ cost ledger│   │ LLM (ambiguous)│  │  ladder      │   │ score        │
└──────────────┘   └────────────┘   └───────────────┘   └──────────────┘   └──────────────┘
      listings            listings          comps            valuations       recommendations
```

Postgres is the whole state store (pgvector for optional semantic matching, pg_trgm
for the matcher). Redis + BullMQ for the job queue and cron. Fastify serves the API
and the single-file dashboard.

Key design decisions and the reasoning behind them are in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
Fee and marketplace assumptions — and how to correct them — are in [docs/FEES.md](docs/FEES.md).
Box configurations are in [docs/BOXES.md](docs/BOXES.md), player photographs and their
licensing in [docs/PORTRAITS.md](docs/PORTRAITS.md), and
[docs/PLAYER-ART.md](docs/PLAYER-ART.md) covers the nation-kit avatars, how to correct a
nation's colours, and a prompt pack for generating stylised card art with an image model
— including why generating real named players is the wrong tool.

## API

```
GET  /api/health                    capabilities + data freshness
GET  /api/health/sources            per-source health — check here when prices stop moving
POST /api/collection/parse          bulk entry, dry run: match typed lines, write nothing
POST /api/collection/bulk           commit reviewed lines (skuId, or cardId + parallel to declare)
POST /api/collection/add            add a card: version + qty + cost + box + photo in one call
PUT  /api/collection/:skuId         edit a holding line outright
POST /api/cards/custom              create a card the checklist doesn't have (and hold it)
POST /api/photos/:skuId             upload your own photo (data URL)
GET  /api/boxes                     box/pack configurations
GET  /api/boxes/for-section         which box a given subset comes out of
GET  /api/parallels                 parallels declared for a section
GET  /api/players                   one row per player: portrait status, cards, value, action
GET  /api/players/:name             their page — owned versions, what's missing, totals
POST /api/players/backfill          look up portraits (Wikidata → Commons)
POST /api/players/:name/portrait    look one up, or pin your own image
GET  /api/img/player/:name          player avatar
GET  /api/gallery                   image-tile payload: photo, price, sparkline, action — one request
GET  /api/overview                  every dashboard aggregate in one request
GET  /api/img/:skuId                card photo, or a generated placeholder; never a 404
POST /api/images/refresh            harvest photos from matched listings
POST /api/images/:skuId             pin your own scan to a card
GET  /api/cards                     checklist w/ live prices; filters, facets, sorting
GET  /api/cards/:skuId              full detail: valuation history, every comp, siblings
GET  /api/portfolio                 holdings + totals + comp-backed coverage
POST /api/holdings                  {skuId|cardId, qty, costBasisAud, priceOverrideAud}
POST /api/sales                     log a sale; fees modelled if you don't supply them
GET  /api/recommendations           ranked by money at stake
POST /api/recommend                 {skuId?} — recompute
GET  /api/where-to-sell?grossAud=   net-proceeds ladder for any price
GET  /api/marketplaces              fee/shipping/realization model
GET  /api/communities               channel metadata
POST /api/ingest                    {mode:'hot'|'full'|'held'|'card', cardIds?}
POST /api/import/comps-csv          paste sold comps — full trust weight, no keys needed
POST /api/import/legacy-json        HTML tracker save file
POST /api/ask                       {question} — NL → guarded SQL → answer
GET  /api/alerts                    price moves, closing sell windows, thin-data warnings
```

Writes require `x-api-key: $ADMIN_API_KEY` when that variable is set.

## What this does not do

- **It is not a price oracle.** Every figure carries `method` and `confidence`, and
  the UI marks anything that isn't comp-backed. A `seed`/`tier_avg`/`parallel_mult`
  valuation is a guess with a number attached. Verify before a big sale.
- **It does not have Marketplace Insights access for you.** Until eBay approves
  your application, sold comps come from scraping or manual import.
- **The fee and realization tables are starting points.** They live in Postgres so
  you can correct them; see docs/FEES.md.
- **Regional demand priors are priors.** They only apply until a marketplace has
  its own comps, at which point real data takes over completely.
- **Box configurations are seeded for the two flagship products only.** Everything
  else is yours to add, and every figure is editable — see docs/BOXES.md.
- **Card photos start empty.** They accumulate as listings get matched, so a fresh
  install is all generated artwork and kit avatars until the first ingest cycle runs.
- **Nation kit colours are seeded by hand.** 46 of the 56 are ones I'm confident
  about; the rest carry `verified = false` and are best guesses. Fix any of them with
  one `UPDATE` — see docs/PLAYER-ART.md.
- **Not financial advice.** It is a hobby tool that does arithmetic you'd otherwise
  do badly in your head.

## Legal / operational notes

Scraping is off by default. If you enable it: `SCRAPE_MIN_DELAY_MS` is enforced
through a global single-flight mutex, robots.txt and site terms are your
responsibility, and the free tier exists for low-volume personal use, not scale.
Bright Data is the supported path for volume. Bright Data and AI spend are both
capped in `.env` — set them before you turn either on.
