# CardVault on your phone, as an app

The goal: tap an icon on your home screen, no browser bar, works from anywhere, same data as
the laptop. Your friends get a link and do the same.

Everything below already exists in the app — the icon, the manifest, the offline shell. The
only thing missing is a **web address that does not change**, and that is what this document
sets up.

---

## Why your phone can't just find the PC

Your PC sits behind a home router with no public address. The internet cannot start a
conversation with it — that is not a setting, it is how home internet works.

You currently work around that with a Cloudflare *quick* tunnel. It works, and it has one
fatal flaw for this purpose: **the address is random and changes every time it restarts.**

```
funk-anna-allowing-midwest.trycloudflare.com     <- today
sudden-tiger-plastic-vermont.trycloudflare.com   <- after the next reboot
```

A home-screen icon is a saved URL. When the URL dies, the icon opens a dead page, and there is
no way to guess the new one — you have to walk to the PC and read it off the screen. That is
the whole problem.

## What we do instead

Your VPS has something your PC does not: a permanent public address. It is far too small to
*run* CardVault — 362 MB free, one vCPU, no swap — but it is more than big enough to be a
**doorway**.

```
   phone ──https──▶  VPS :443  ──▶ 127.0.0.1:8090
                    (nginx)              │
                                         │  ssh tunnel, opened BY the PC
                                         ▼
                                    your PC :8080
                                    (Docker, Postgres, photos)
```

The PC dials outward to the VPS and asks it to hold a port open. So:

- **Nothing is forwarded on your home router.** Your home IP is never published.
- **The address never changes.** It is your VPS.
- **Real HTTPS**, which is what makes "add to home screen" behave like an app rather than a
  bookmark. Phones will not install a home-screen app over plain `http`.
- **The VPS does almost nothing.** nginx and sshd are already running on it. Memory cost is
  close to zero, so the trading bot is unaffected.
- When the PC is off, the address says *"CardVault is asleep"* instead of hanging.

---

## Setup

Five steps. Steps 1–3 are on the VPS, 4–5 on the PC. Budget half an hour.

### 1. Get a free hostname (2 minutes)

Certificates cannot be issued for a bare IP address, and without a certificate there is no
HTTPS and no home-screen app. You need a name. If you own a domain, use it. If not,
[duckdns.org](https://www.duckdns.org) gives you one free, forever, signed in with a Google
or GitHub account.

1. Sign in, type a name — say `ibicards` — and click **add domain**.
2. In the **current ip** box put your VPS address (`134.199.169.129`) and click **update ip**.

You now own `ibicards.duckdns.org`. Check it points at the right place:

```bash
ping -c1 ibicards.duckdns.org
```

> DuckDNS is a real DNS provider as far as Let's Encrypt is concerned, so certificates work
> normally. Two limits worth knowing before you rely on it: the name is not yours in any legal
> sense, and if DuckDNS is ever down, new certificate issuance fails (an existing certificate
> keeps working). For a tool you and three friends use, that is a fine trade. If it ever
> stops being fine, buying a domain is a ten-minute change to one line of nginx config.

### 2. Point nginx at the tunnel (VPS)

```bash
sudo cp infra/nginx-cardvault.conf /etc/nginx/sites-available/cardvault
sudo sed -i 's/CARDVAULT_HOST/ibicards.duckdns.org/g' /etc/nginx/sites-available/cardvault
sudo ln -sf /etc/nginx/sites-available/cardvault /etc/nginx/sites-enabled/cardvault
sudo nginx -t
```

`nginx -t` will complain that the certificate files do not exist. That is expected — step 3
creates them. **Do not reload nginx yet**; a reload now would fail and take your existing
port 80 site down with it.

### 3. Turn on HTTPS (VPS)

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d ibicards.duckdns.org
```

certbot proves you control the name over port 80, writes the certificate, edits the config to
point at it, and reloads nginx. Renewal is automatic — it installs its own timer.

Check it took:

```bash
sudo nginx -t && curl -I https://ibicards.duckdns.org
```

You should get `503` and the "CardVault is asleep" page. **That is success.** HTTPS is
working; there is just no tunnel yet.

### 4. Make a key for the tunnel (PC)

In PowerShell, on the PC:

```powershell
ssh-keygen -t ed25519 -f "$HOME\.ssh\cardvault_tunnel" -C cardvault-tunnel
type "$HOME\.ssh\cardvault_tunnel.pub" | ssh root@134.199.169.129 "mkdir -p ~/.ssh && cat >> ~/.ssh/authorized_keys"
```

**Leave the passphrase empty** when it asks. A passphrase means the tunnel cannot reconnect on
its own after a reboot, which defeats the entire point.

An empty-passphrase key that can log in as root is worth thinking about for a second. Lock it
down so it can *only* forward a port — edit `~/.ssh/authorized_keys` on the VPS and put this
in front of the key you just added, on the same line:

```
restrict,port-forwarding,command="echo no shell" ssh-ed25519 AAAA...
```

Now if that key is ever stolen, it buys the thief one thing: the ability to forward a port on
your VPS. No shell, no files, no agent.

### 5. Start the tunnel, and make it permanent (PC)

Test it once, in a visible window:

```powershell
.\tools\tunnel.ps1 -VpsHost 134.199.169.129 -VpsUser root
```

Open `https://ibicards.duckdns.org` on the laptop. If CardVault loads, it works. Then install
it as a scheduled task so you never think about it again — **from an admin PowerShell**:

```powershell
.\tools\install-tunnel-task.ps1 -VpsHost 134.199.169.129 -VpsUser root
Start-ScheduledTask -TaskName 'CardVault tunnel'
```

It now starts a few seconds after you sign in, survives sleep, and reconnects on its own —
the log is at `logs\tunnel.log`:

```powershell
Get-Content .\logs\tunnel.log -Wait -Tail 20
```

### 6. One setting in `.env`

There is now a proxy in front of the app, so it must be told to believe the
`X-Forwarded-For` header. Without it, every visitor arrives as the VPS's own address: the
login throttle counts per *(username, IP)*, so it would no longer be able to tell two
different people apart, and every line in the log would name the VPS instead of whoever was
actually there.

```
TRUST_PROXY=true
```

Then `docker compose up -d --force-recreate api`.

> This is the one setting that must **not** be on when nothing is in front of the app: with no
> proxy, anyone can forge that header and the throttle stops working. Turn it on at the same
> time as nginx, not before.

---

## Putting it on the home screen

**iPhone** — open the address in **Safari** (not Chrome; only Safari can install). Share
button → *Add to Home Screen*. You get the CardVault icon, no browser bar.

**Android** — open in Chrome, menu → *Install app* or *Add to Home Screen*.

Your friends do exactly the same, then sign in with their own name and password. They see your
collection and you see theirs; neither of you sees what the other paid, and neither can edit
the other's cards or photographs.

---

## What still needs the PC to be on

Everything. The VPS is a doorway, not a copy — the database and the photographs live on the
PC. If the PC is off or asleep the address politely says so.

The app caches its own screen and the pages you have looked at, so a phone with no signal
still opens and shows the last thing it saw. **It does not queue changes.** Adding a card or a
photograph while offline will fail rather than silently pretend to work — a write that looks
saved and is not is worse than one that plainly refuses, especially when two people are
editing.

---

## If it breaks

| What you see | What it means |
|---|---|
| "CardVault is asleep" | PC off, Docker down, or the tunnel dropped. Check `logs\tunnel.log`. |
| `502 Bad Gateway` | nginx is up but its `error_page` rule was lost — re-check the config. |
| `413` when saving a photo | `client_max_body_size` is missing from the nginx config. It must be `20m`. |
| Logged out constantly on the phone | `TRUST_PROXY` or `X-Forwarded-Proto` missing, so the session cookie is not marked secure. |
| "Add to Home Screen" gives a bookmark, not an app | You opened it over `http`, or in Chrome on iPhone. Must be `https`, and Safari on iPhone. |
| Certificate expired | `sudo certbot renew --dry-run` on the VPS. Usually the port-80 redirect swallowed the ACME path. |

Check the tunnel from the VPS side:

```bash
ss -ltn | grep 8090        # bound = the PC is connected
curl -s localhost:8090/api/health
```

---

## Why not just run it on the VPS?

Because it will not fit, and finding that out slowly is worse than being told.

| | Your droplet | What CardVault needs |
|---|---|---|
| Memory | 1.9 GB total, **362 MB free** | Postgres + pgvector, Redis, Node, worker — comfortably over 1 GB |
| Swap | none | — |
| CPU | 1 vCPU, shared with your trading bot | — |
| Port 8080 | taken by the trading bot | — |
| Photo storage | droplet disk, billed | grows with every card you shoot |

It would swap itself to a standstill and take the trading bot down with it. Meanwhile the PC
you already own has the memory, the disk and the CPU sitting idle. Using the VPS as a doorway
uses the one thing it genuinely has — a permanent address — and none of the things it does not.
