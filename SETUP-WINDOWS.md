# Setting CardVault up on Windows

## The short version

```powershell
cd C:\lego\tradingcard\cardvault
.\setup.ps1
```

That needs **Docker Desktop** running and nothing else — the containers bring Node 22,
Postgres 16 with pgvector, and Redis. First run takes a few minutes (it pulls images and
compiles TypeScript), then the dashboard is at <http://localhost:8080>.

If PowerShell refuses to run the script:

```powershell
powershell -ExecutionPolicy Bypass -File .\setup.ps1
```

`.env` has already been created for you with a generated database password and admin key.
Everything else in it is optional and off by default.

---

## What the script actually does

1. Copies `.env.example` to `.env` if it is missing, with a random password rather than
   `change-me` — a default password in a file called `.env` has a way of reaching
   production.
2. `docker compose up -d --build`, which starts five things in order: **db** → **redis** →
   **migrate** (runs the 11 migrations, then seeds 1,771 cards and 164 parallels) →
   **api** → **worker**.
3. Polls `/api/health` until it answers, then prints how many cards seeded.

The API deliberately waits for `migrate` to *complete* before starting, so if something
is wrong you will see it in that container's log rather than as a confusing API error:

```powershell
docker compose logs migrate
```

## Everyday commands

```powershell
docker compose logs -f api          # follow the API
docker compose restart api worker   # after editing .env
docker compose down                 # stop; the database survives
docker compose down -v              # stop and DELETE the database
.\setup.ps1 -Reset                  # same, with a confirmation prompt
```

## Without Docker

```powershell
.\setup.ps1 -Local
```

You supply Postgres 16 and Redis yourself. Postgres must have **pgvector**, **pg_trgm**
and **unaccent** available — `pg_trgm` and `unaccent` ship with Postgres, but `pgvector`
does not, and the migrations will stop on `CREATE EXTENSION vector` without it. On Windows
the least painful way to get it is to run just the database in Docker and keep Node local:

```powershell
docker compose up -d db redis
$env:DATABASE_URL = "postgres://cardvault:PASSWORD_FROM_ENV@127.0.0.1:5432/cardvault"
$env:REDIS_URL    = "redis://127.0.0.1:6379"
npm install
npm run migrate
npm run seed
npm run dev:api      # terminal 1  -> http://localhost:8080
npm run dev:worker   # terminal 2
```

`npm run dev:api` restarts on save, which is what you want while changing anything in
`web/index.html`.

## Once it is up

**Add what you own.** The `+` on any tile, or the *Add card* button. Parallels and grades
that nobody has recorded yet are created rather than refused, and anything off-checklist
goes in as a custom card.

**Fetch player photographs.** This is the step that turns the generated figures into real
faces, and it needs outbound internet — which is why the pack I sent is all generated art.

```powershell
docker compose exec api node dist/cli/portraits.js
docker compose exec api node dist/cli/portraits.js --status
```

Licensing matters here: portraits come from Wikimedia Commons under CC BY / CC BY-SA and
the author, licence and source are stored and displayed. Read `docs/PORTRAITS.md` before
republishing any of them.

**Turn on a price source.** Everything works without one — the seeded estimates carry you
— but prices stay frozen until a source is live. In preference order:

| source | what to set | notes |
|---|---|---|
| eBay Marketplace Insights | `EBAY_CLIENT_ID`, `EBAY_CLIENT_SECRET`, `EBAY_INSIGHTS_ENABLED=true` | real sold comps; needs eBay to approve your application |
| Bright Data | `BRIGHTDATA_API_KEY`, `BRIGHTDATA_ENABLED=true` | paid per request, capped by `BRIGHTDATA_MONTHLY_REQUEST_CAP` |
| self-scraping | `SCRAPE_ENABLED=true` | off by default on purpose; rate-limited, single-flight, circuit-broken |
| manual CSV | nothing | Data & sources tab. Manual comps carry full trust weight |

**AI features are optional.** Without `ANTHROPIC_API_KEY` the matcher stays deterministic,
the natural-language tab is disabled, and everything else works identically. With it, the
monthly spend is capped by `AI_MONTHLY_BUDGET_USD`.

## Two things worth knowing

**The image cache is ephemeral in Docker.** `IMAGE_CACHE_DIR` points inside the container
and `docker-compose.yml` mounts no volume for it, so harvested photos re-download after a
rebuild. Harmless, but if you would rather keep them, add to the `api` service:

```yaml
    volumes:
      - images:/var/lib/cardvault/images
```

and `images:` under the top-level `volumes:` block.

**Port 5432 is often already taken** on a machine that has had Postgres installed before.
If `docker compose up` fails on the database port, change `POSTGRES_PORT` in `.env` to
`5433` — the containers talk to each other on the internal network, so only your own
`psql` connections are affected.
