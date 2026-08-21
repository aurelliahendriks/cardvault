# Start here

**Mac:** double-click **`start.command`**
**Windows:** double-click **`start.bat`**

That's it. It checks Docker, starts everything, waits until it's actually ready, and opens
your browser at **http://localhost:8080**.

First run takes a few minutes — it downloads the database and loads all 2,521 cards. After
that it's seconds.

---

## The one thing that trips everyone up

**Do not open `web/index.html` by double-clicking it.**

Your old tracker was one file with all the cards baked in, so double-clicking worked. This one
can't be, because your laptop and your phone have to see the *same* collection — so the cards,
the checklist and the photos live in the app, and `index.html` is only the screen that shows
them.

Opened on its own it looks completely fine and does absolutely nothing. (It now says so
instead of sitting there silently, but the fix is the same: go to `localhost:8080`.)

**Bookmark `localhost:8080`.** That's the app.

---

## Putting your cards in

Sign in, then use the **⚡ Quick add** bar at the top:

1. Pick the set — Donruss, Panini WC, Prizm, Select, Topps Chrome
2. Pick the section — Base, Kaboom!, Field Level, whatever the card is
3. Type the number off the front of the card and press **Enter**

That's the whole loop. The box clears itself and the cursor stays put, so you just keep
typing: `245` Enter, `181` Enter, `12` Enter. Type `2 3 4` Enter to log three at once. Type
the same number twice and it records a duplicate rather than a second line.

**Extras ▾** opens parallel, serial number, grade and what you paid. Those stay selected until
you press Clear — handy for a run of Golds, worth remembering when you go back to base cards.

Each card you log stays on screen with **📷 front** and **📷 back**, so you photograph it right
there instead of going to find it again.

---

## Everyday commands

Run these in the cardvault folder.

| | |
|---|---|
| `docker compose up -d` | start it |
| `docker compose down` | stop it (your cards are kept) |
| `docker compose logs -f api` | watch what it's doing |
| `docker compose restart api` | after changing `.env` |

Back it up now and then — `tools/backup.ps1` on Windows. It saves the database *and* your
photos, and checks both actually made it.

---

## The rest of the folder

You never need to open any of these, but so nothing is a mystery:

| | |
|---|---|
| `web/index.html` | the whole screen — one file |
| `db/cardvault.sql` | the whole database shape — one file |
| `db/seeds/cards.json` | all 2,521 cards |
| `src/` | the server |
| `docs/PHONE-APP.md` | putting it on your phone as an app |
| `docs/ARCHITECTURE.md` | why things are built the way they are |
| `photos/` | your card photos, as ordinary files you can open |
