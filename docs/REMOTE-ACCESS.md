# Reaching CardVault from a phone

Your PC is the server. There are three ways to get to it from a phone, and they are not
equivalent — the difference decides whether "Add to Home Screen" gives you an app or a bookmark.

| | Works away from home | Real HTTPS | Installs as an app | Router changes |
|---|---|---|---|---|
| **Same wifi, plain http** | no | no | no | none |
| **Cloudflare Tunnel** | yes | yes | **yes** | none |
| **Port forwarding + certificate** | yes | yes | yes | yes, and it exposes your PC |

## Why HTTPS is not optional for the app install

Browsers refuse to register a service worker over plain `http` on anything but `localhost`, and
a service worker is what a PWA *is*. So on `http://192.168.0.144:8080`:

- **iOS** will happily add a home-screen icon, and it behaves like a bookmark. It opens Safari,
  keeps the address bar, and has no offline cache.
- **Android/Chrome** will not offer to install at all.

This is not a CardVault limitation and there is no flag to turn it off. It is why the tunnel is
worth the fifteen minutes.

## Same wifi (works today, no setup)

Find your PC's LAN address — the `192.168.x.x` one, not the VirtualBox, WSL or Tailscale
adapters:

```powershell
(Get-NetIPAddress -AddressFamily IPv4 -PrefixOrigin Dhcp).IPAddress
```

Then `http://<that address>:8080` on the phone. Allow it through the firewall the first time
Windows asks. Good enough for entering cards on the sofa; useless at a card show, and no install.

## Cloudflare Tunnel (recommended)

An outbound-only connection from your PC to Cloudflare, which hands you a real
`https://something` address. Nothing is opened on your router, and your home IP is never
exposed. Free for this.

### 1. Install

```powershell
winget install --id Cloudflare.cloudflared
```

### 2. Try it with a throwaway address first

```powershell
cloudflared tunnel --url http://localhost:8080
```

It prints a `https://random-words-here.trycloudflare.com` URL. Open it on the phone. If the app
loads and you can sign in, the plumbing works — and you can now install it properly, because
that URL is genuine HTTPS.

That address dies when you close the window, which makes it perfect for testing and useless as
the thing you send your friends.

### 3. Make it permanent

Needs a domain on Cloudflare (a cheap `.au` or `.com` is fine; a free DuckDNS name will **not**
work here — this route wants the domain's DNS on Cloudflare).

```powershell
cloudflared tunnel login
cloudflared tunnel create cardvault
cloudflared tunnel route dns cardvault cards.yourdomain.com
```

Then a config file at `C:\Users\<you>\.cloudflared\config.yml`:

```yaml
tunnel: cardvault
credentials-file: C:\Users\<you>\.cloudflared\<tunnel-id>.json
ingress:
  - hostname: cards.yourdomain.com
    service: http://localhost:8080
  - service: http_status:404
```

Install it as a Windows service so it survives a reboot:

```powershell
cloudflared service install
```

### 4. Tell CardVault it is behind a proxy

**This step is not optional, and skipping it locks everybody out.**

Set `TRUST_PROXY=true` in `.env`, then `docker compose restart api`.

Every request now arrives from Cloudflare's address rather than the visitor's. Without
`TRUST_PROXY`, the login throttle sees all of them as one client — so five wrong password
attempts by anyone, anywhere, locks out the whole household. It also means the session cookie is
correctly marked `secure`, which it cannot be if the app thinks the connection is plain http.

The reverse matters too, which is why this is a switch and not a default: with `TRUST_PROXY=true`
and **no** proxy in front, `X-Forwarded-For` becomes a header anyone can set, and the login
throttle stops existing.

## Before you expose it, three things

1. **A password on every account.** `docker compose exec api npx tsx src/cli/user.ts` — anything
   listed as `never signed in` with no password cannot sign in, which is fine, but check there is
   no account you forgot about.
2. **A backup.** `.\tools\backup.ps1`. Do this before the first time anyone else can reach it,
   not after.
3. **Know the honest limits.** The login throttle is in memory, so restarting the API clears it.
   There is no email verification, no password reset, and no audit log. For a handful of friends
   with real passwords behind HTTPS that is a reasonable place to stop; it is not a public
   service, and it should not be advertised as one.

## Backups

```powershell
.\tools\backup.ps1              # dated dump in .\backups, verified, keeps 14
.\tools\backup.ps1 -Keep 30 -OutDir D:\backups
```

Schedule it daily:

```powershell
$action  = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument '-NoProfile -ExecutionPolicy Bypass -File "C:\lego\tradingcard\cardvault\tools\backup.ps1"'
$trigger = New-ScheduledTaskTrigger -Daily -At 3am
Register-ScheduledTask -TaskName 'CardVault backup' -Action $action -Trigger $trigger `
  -Description 'pg_dump of the CardVault database, verified and rotated'
```

The script verifies each dump with `pg_restore --list` before keeping it, and checks the file
starts with `PGDMP` after copying it out of the container. That second check exists because the
obvious way to write this script — piping `pg_dump` to a PowerShell file — silently corrupts the
archive: PowerShell decodes process output as text. The failure is invisible until the day you
try to restore.

**Put the backups on a different disk from the database.** A dump sitting next to the thing it
protects survives a mistake but not a dead drive.
