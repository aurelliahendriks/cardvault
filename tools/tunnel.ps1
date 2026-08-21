# CardVault :: keep a door open from your PC to the VPS.
#
#   .\tools\tunnel.ps1 -VpsHost 134.199.169.129 -VpsUser root
#   .\tools\tunnel.ps1 -VpsHost 134.199.169.129 -VpsUser root -Once     # one attempt, for testing
#
# ---------------------------------------------------------------------------
# WHY THE PC DIALS OUT INSTEAD OF THE VPS DIALLING IN
# ---------------------------------------------------------------------------
#
# Your PC sits behind a home router with no public address. The internet cannot start a
# conversation with it. So the PC starts the conversation: it opens an ordinary outbound SSH
# connection to the VPS and asks the VPS to keep a port open on ITS side, wired back down the
# same connection.
#
#     ssh -R 127.0.0.1:8090:localhost:8080  you@vps
#          ^^^^^^^^^^^^^^^^ ^^^^^^^^^^^^^^
#          on the VPS       means "your PC's port 8080"
#
# Three consequences, all of them wanted:
#
#   * Nothing is forwarded on your home router. Port forwarding publishes your home IP and
#     opens a hole that stays open whether or not you are using it.
#   * `127.0.0.1:8090` binds to the VPS's LOOPBACK only, which is sshd's default behaviour
#     (`GatewayPorts no`). Nobody on the internet can reach the tunnel directly - everything
#     must arrive through nginx, and therefore through HTTPS.
#   * When the PC sleeps the connection dies and the address returns "CardVault is asleep"
#     rather than hanging. When it wakes, the loop below reconnects within seconds.
#
# ---------------------------------------------------------------------------
# WHY THIS IS A LOOP AND NOT ONE `ssh` COMMAND
# ---------------------------------------------------------------------------
#
# A laptop lid closing kills the connection. So does the wifi changing, the VPS rebooting, and
# an ISP that quietly drops idle connections overnight. A single `ssh -R` handles none of
# those: it exits, and the address is dead until somebody notices and retypes the command.
# The point of this script is that nobody has to notice.

param(
  [Parameter(Mandatory = $true)][string]$VpsHost,
  [string]$VpsUser     = 'root',
  [int]   $VpsPort     = 22,
  [int]   $RemotePort  = 8090,        # the port nginx proxies to, on the VPS's loopback
  [int]   $LocalPort   = 8080,        # where CardVault listens on this PC
  [string]$KeyFile     = "$HOME\.ssh\cardvault_tunnel",
  [string]$LogFile     = "$PSScriptRoot\..\logs\tunnel.log",
  [switch]$Once
)

$ErrorActionPreference = 'Stop'

$logDir = Split-Path $LogFile -Parent
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }

function Say($msg, $colour = 'Gray') {
  $line = "{0}  {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
  Write-Host $line -ForegroundColor $colour
  Add-Content -Path $LogFile -Value $line
}

# --- preflight -------------------------------------------------------------
# Each of these fails in a way that looks like something else if you do not check it here.
# "ssh is not recognized" reads as a broken script; a missing key reads as a wrong password;
# a dead local app reads as a broken tunnel.

# `ssh`, not `ssh.exe`: PowerShell resolves the .exe on Windows through PATHEXT, and the bare
# name is also what exists on macOS and Linux. Same script, three operating systems, and this
# household already has two of them.
$ssh = Get-Command ssh -ErrorAction SilentlyContinue
if (-not $ssh) {
  throw "ssh not found. On Windows 10/11 it is an optional feature: " +
        "Settings > System > Optional features > Add > 'OpenSSH Client'. " +
        "On macOS it is already installed."
}

if (-not (Test-Path $KeyFile)) {
  Write-Host ''
  Write-Host "No SSH key at $KeyFile." -ForegroundColor Yellow
  Write-Host 'Create one and install it on the VPS - two commands, then a password once:' -ForegroundColor Yellow
  Write-Host ''
  Write-Host "  ssh-keygen -t ed25519 -f `"$KeyFile`" -C cardvault-tunnel"
  Write-Host "  type `"$KeyFile.pub`" | ssh $VpsUser@$VpsHost `"mkdir -p ~/.ssh && cat >> ~/.ssh/authorized_keys`""
  Write-Host ''
  Write-Host 'Leave the passphrase EMPTY when ssh-keygen asks. A passphrase means the tunnel' -ForegroundColor DarkGray
  Write-Host 'cannot reconnect on its own after a reboot, which defeats the point. The key only' -ForegroundColor DarkGray
  Write-Host 'grants what the VPS lets it grant - see docs/PHONE-APP.md for locking it down to' -ForegroundColor DarkGray
  Write-Host 'port forwarding alone.' -ForegroundColor DarkGray
  throw "missing key"
}

# --- the loop --------------------------------------------------------------
#
# Backoff, so a VPS that is genuinely down does not get hammered once a second all night, and
# so the log stays readable. It resets the moment a connection lasts long enough to have been
# real - otherwise a tunnel that flaps every 20 seconds would slowly climb to a 5-minute delay
# and stay there, and the app would appear to be down for minutes at a time.

$delay = 2
$maxDelay = 60
$attempt = 0

Say "tunnel starting: this PC :$LocalPort  ->  ${VpsUser}@${VpsHost} :$RemotePort" 'Cyan'

while ($true) {
  $attempt++

  # Is the app actually up? Checked BEFORE dialling, because an ssh session opened against a
  # dead local port connects happily and then refuses every request - so the VPS reports a
  # healthy tunnel while nothing works, which is harder to diagnose than no tunnel at all.
  #
  # Note what this deliberately does NOT do: it does not keep watching. If Docker stops while
  # a tunnel is already up, the session stays open, requests get refused, nginx turns that
  # into the "asleep" page, and the moment Docker returns the SAME session starts working
  # again with no reconnect at all. Polling in order to tear down a link that will heal
  # itself would make things worse. Verified both ways.
  $up = $false
  try {
    $c = New-Object Net.Sockets.TcpClient
    $c.Connect('127.0.0.1', $LocalPort); $up = $c.Connected; $c.Close()
  } catch { $up = $false }
  if (-not $up) {
    Say "CardVault is not answering on localhost:$LocalPort - is Docker running? retrying in 15s" 'Yellow'
    if ($Once) { exit 1 }
    Start-Sleep -Seconds 15
    continue
  }

  # NOT `$args`: that is a PowerShell automatic variable holding the parameters passed to the
  # current scope. Assigning to it is legal and works here, which is exactly what makes it a
  # trap - it breaks silently and confusingly the first time this code is moved into a
  # function or a script block.
  $sshArgs = @(
    '-N',                                   # forward only; do not run a shell
    '-T',                                   # no terminal
    '-i', $KeyFile,
    '-p', "$VpsPort",
    '-R', "127.0.0.1:${RemotePort}:localhost:${LocalPort}",
    # Detect a dead link in ~90s instead of waiting for TCP to give up, which can be hours.
    '-o', 'ServerAliveInterval=30',
    '-o', 'ServerAliveCountMax=3',
    # If the remote port cannot be bound - usually a previous session still holding it - FAIL
    # rather than sitting there connected and forwarding nothing. This is the difference
    # between "the tunnel is down" and "the tunnel is up and lying".
    '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ConnectTimeout=15',
    # accept-new, never `no`: it trusts the VPS's fingerprint the first time and refuses if it
    # ever CHANGES. `StrictHostKeyChecking=no` would accept a different machine silently,
    # which is the whole attack.
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'BatchMode=yes',                  # never prompt; this may run with nobody watching
    "$VpsUser@$VpsHost"
  )

  $started = Get-Date
  Say "connecting (attempt $attempt)"
  & $ssh.Source @sshArgs 2>&1 | ForEach-Object { Say "  ssh: $_" 'DarkGray' }
  $lived = (Get-Date) - $started

  if ($Once) { Say "one-shot finished after $([int]$lived.TotalSeconds)s"; exit 0 }

  if ($lived.TotalSeconds -ge 60) {
    Say ("tunnel closed after {0:N0} min - reconnecting" -f $lived.TotalMinutes) 'Yellow'
    $delay = 2
  } else {
    Say "tunnel dropped after $([int]$lived.TotalSeconds)s - retrying in ${delay}s" 'Yellow'
  }

  Start-Sleep -Seconds $delay
  $delay = [Math]::Min($maxDelay, $delay * 2)
}
