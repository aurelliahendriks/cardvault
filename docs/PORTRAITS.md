# Player portraits

## Where they come from

Wikidata → Wikimedia Commons. Free, no API key, covers essentially every player in a
World Cup product, and — the reason it was chosen over anything faster — it carries
machine-readable licensing. Scraping faces off a news site would have been quicker to
write and would have handed you images you have no right to display.

The lookup is three calls per player:

1. `wbsearchentities` on the name → up to 5 candidate Wikidata items.
2. `wbgetentities` → the first candidate whose occupation (**P106**) is a footballer.
3. Commons `imageinfo` on that item's image (**P18**) → a server-generated 320px
   thumbnail plus licence, author and file-page URL.

**Step 2 is not optional.** Without the occupation check, name collisions resolve to a
musician or a politician and you end up with a confidently wrong face on a card. The
test suite covers exactly this case: a search that returns the musician first still
resolves to the footballer.

## Licensing — read this before republishing anything

Commons images are overwhelmingly **CC BY** or **CC BY-SA**. Both *require*
attribution: author, licence, and a link back to the source. A few are CC0 or public
domain and don't.

What the app does about it:

- Stores `author`, `license`, `license_url` and `credit_url` for every portrait.
- Displays the credit on the player page wherever the portrait appears.
- Sets `attribution_required = false` only for CC0 / public-domain files.
- **Refuses** anything whose licence can't be established — `license_unclear` — rather
  than guessing. An unclear licence is treated as unusable.

What it can't do for you: if you export card art or a player page into something
public — a listing, a social post, a printed binder page — the credit has to travel
with it. The data is all in the `players` table so you can render it wherever you need.

Non-free, fair-use and all-rights-reserved files are rejected outright.

## How a portrait is used

Two different renders, because they answer different questions:

- **Player avatar** (`/api/img/player/:name`) — full-bleed portrait. The collection
  grid asks "who is this?", so the face fills the tile.
- **Card art** (`/api/img/:skuId`) — the portrait sits in an *inset window* with the
  set's artwork framing it. Full-bleed was tried first and was wrong: a Kaboom
  starburst and Optic refractor bands both disappeared behind the face, so every
  version of a card looked identical again, which defeats the point of showing
  pictures at all.

The portrait is inlined into the SVG as a base64 data URI. That isn't laziness — an
SVG loaded through an `<img>` tag is not permitted to fetch external resources, so a
referenced portrait simply would not render.

Priority order for what you see on a card:

1. your own uploaded photo
2. a photo harvested from a matched sold listing
3. a photo inherited from another version of the same card
4. generated set artwork **with the player's portrait framed inside**
5. generated set artwork with the player's monogram

## Running it

```bash
# nightly by default (CRON_PORTRAITS), or on demand:
curl -X POST localhost:8080/api/players/backfill -d '{"limit":60}' -H 'Content-Type: application/json'

# one player, now
curl -X POST "localhost:8080/api/players/Lamine%20Yamal/portrait" -d '{}' -H 'Content-Type: application/json'

# how it's going
curl localhost:8080/api/players/portraits/status
```

Backfill is ordered by what you own and what it's worth, so the cards you care about
get faces first. It sleeps ~700 ms between lookups — this is a free service run on
donations, and hammering it would be rude as well as counterproductive.

Statuses you'll see: `ok`, `not_found` (no Wikidata match, or matches but none is a
footballer), `no_image` (entry exists but has no P18), `license_unclear`, `error`,
`manual` (you set it yourself), `pending`.

## Using your own image instead

```bash
curl -X POST "localhost:8080/api/players/Some%20Player/portrait" \
  -H 'Content-Type: application/json' \
  -d '{"photo":"data:image/jpeg;base64,...","author":"Me","license":"Own work"}'
```

Manual portraits are never overwritten by the backfill.

## Rate limiting, and the arithmetic I got wrong

The first real backfill came back with **216 of 225 players marked `error`, all of them
`429 Too Many Requests`**. Individually every lookup worked perfectly; in bulk they were
all refused.

The bug was a unit mistake. The delay was 700ms *per player* — but a player costs up to
five requests: `wbsearchentities`, `wbgetentities` for claims, a second `wbgetentities`
for the position and club labels, Commons `imageinfo`, then the image download itself.
That is about seven requests per second at Wikimedia, sustained for minutes.

Three changes:

**Spacing moved from between players to between requests.** One adaptive pacer wraps every
Wikimedia call, including the image download, which had been outside it entirely.
`WIKIMEDIA_MIN_INTERVAL_MS` sets the floor (1100ms by default).

**A 429 is transient, not a failure.** It doubles the interval, honours `Retry-After`,
retries up to three times, and creeps back 5% per success afterwards. If it still can't
get through, the row stays **pending** rather than `error` — because the player was never
actually looked up, and recording that as a permanent failure is what made the next run
skip 216 people. Re-running resumes; no `--retry` needed.

**The backfill stops after five consecutive throttles.** Continuing to hammer a service
that is already refusing is both rude and pointless, and everything left is pending, so
resuming costs nothing.

Rows written by the old version stay `error` with a `429` note, and the backfill skips
`error` — so they need clearing once. `--reset-throttled` does exactly that, and only that:
it matches on the recorded reason, so it cannot sweep a genuine failure back into the
queue. It is not "retry the failures", it is correcting a status that was wrong when it was
written.

`--status` now prints the reasons alongside the counts, and only offers advice the evidence
supports — the first version printed the 403/user-agent tip unconditionally and sent
someone chasing the wrong cause on a rate-limit problem. A bare count of `error` with no
note beside it is a dead end, which is exactly the state this landed in.

Expect a full 783-player backfill to take roughly an hour at the default pace. Run it in
chunks (`--limit=100`) if you would rather watch it.

## Let the worker finish it

Running the backfill through `docker compose exec` ties it to the terminal that launched
it — and to Docker Desktop staying up. Mine died twice: once when the terminal closed, once
when the engine stopped. Each time the fetched rows survived (they are in Postgres) but
nothing resumed on its own.

So the scheduled job does the work now: `CRON_PORTRAITS=*/20 * * * *` with
`PORTRAITS_BATCH=40`, which clears a full 783-player backlog in about five hours across as
many restarts as it takes. Once nothing is pending it costs one SQL query per run and makes
no requests at all, so leaving it on is free.

`backfillPortraits()` also reclaims rows that an older build recorded as `error` with a 429
reason, on every run. Those players were refused before they were ever examined; leaving
them marked as permanent failures meant 216 people would never have been fetched again.
Matching on the recorded reason keeps genuine failures out of the queue.

Nothing to run by hand any more:

```bash
docker compose up -d           # the worker picks up where it left off
docker compose exec api node dist/cli/portraits.js --status   # watch it climb
```
