# CardVault :: make the tunnel start itself, so nobody has to remember.
#
#   .\tools\install-tunnel-task.ps1 -VpsHost 134.199.169.129 -VpsUser root
#   .\tools\install-tunnel-task.ps1 -Remove
#
# Run this from an ADMIN PowerShell window the first time. It registers a Scheduled Task that
# runs tools\tunnel.ps1 in the background whenever you sign in.
#
# ---------------------------------------------------------------------------
# WHY AT LOGON AND NOT AT BOOT
# ---------------------------------------------------------------------------
#
# The SSH key lives in your user profile (C:\Users\you\.ssh), and until you sign in that
# profile is not decrypted or mounted. A task running as SYSTEM at boot cannot read the key,
# fails with "Permission denied (publickey)", and looks for all the world like the key is
# wrong. At logon is the honest trade: the tunnel comes up a few seconds after you sign in.
#
# If you want it up while nobody is signed in, the answer is not this script - it is to run
# CardVault on a machine that stays signed in, or to move the key somewhere SYSTEM can read,
# which means a key readable by anything running as SYSTEM. Recorded so the trade is a choice.

param(
  [string]$VpsHost,
  [string]$VpsUser    = 'root',
  [int]   $VpsPort    = 22,
  [int]   $RemotePort = 8090,
  [int]   $LocalPort  = 8080,
  [string]$TaskName   = 'CardVault tunnel',
  [switch]$Remove
)

$ErrorActionPreference = 'Stop'

if ($Remove) {
  if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "Removed the scheduled task '$TaskName'." -ForegroundColor Green
  } else {
    Write-Host "No scheduled task called '$TaskName'." -ForegroundColor Yellow
  }
  exit 0
}

if (-not $VpsHost) { throw "-VpsHost is required (the address of your VPS)" }

$script = (Resolve-Path "$PSScriptRoot\tunnel.ps1").Path

# -WindowStyle Hidden so it does not put a console window in your face at every sign-in, and
# -ExecutionPolicy Bypass because the default policy blocks unsigned local scripts and the
# failure is a silent non-start rather than a message.
#
# The `-f` MUST be inside the parentheses. Written as
#
#     -Argument ( '...{0}...' ) -f $script, $VpsHost, ...
#
# PowerShell applies -f to the result of the cmdlet rather than to the string, does NOT raise
# an error, and hands the task a command line containing the literal text `-File "{0}"`. The
# task installs, reports success, and fails every single time it runs. Built and confirmed
# before it was fixed.
$argLine = (
  '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}" ' +
  '-VpsHost {1} -VpsUser {2} -VpsPort {3} -RemotePort {4} -LocalPort {5}'
) -f $script, $VpsHost, $VpsUser, $VpsPort, $RemotePort, $LocalPort

if ($argLine -match '\{\d\}') { throw "internal: the argument line was not formatted: $argLine" }

$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $argLine

$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME

# The defaults here are all wrong for a thing that is meant to stay up:
#   * StartWhenAvailable        - run it even if the machine was asleep at the trigger time
#   * DontStopIfGoingOnBatteries / AllowStartIfOnBatteries - a laptop on battery is still a
#     server; the default is to stop the task the moment the charger comes out
#   * ExecutionTimeLimit 0      - the default kills the task after three days. It is a loop
#     that is SUPPOSED to run forever, and the failure would be a tunnel that quietly stops
#     working roughly once a week with nothing in any log to explain it
#   * RestartCount/-Interval    - if the whole script dies, start it again
$settings = New-ScheduledTaskSettingsSet `
  -StartWhenAvailable `
  -DontStopIfGoingOnBatteries `
  -AllowStartIfOnBatteries `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
  -MultipleInstances IgnoreNew

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
  -Settings $settings -Description 'Keeps CardVault reachable from your phone.' -Force | Out-Null

Write-Host ''
Write-Host "Installed '$TaskName'." -ForegroundColor Green
Write-Host "  It starts a few seconds after you sign in, and restarts itself if it dies."
Write-Host ''
Write-Host 'Start it now without signing out:' -ForegroundColor Cyan
Write-Host "  Start-ScheduledTask -TaskName '$TaskName'"
Write-Host ''
Write-Host 'Watch what it is doing:' -ForegroundColor Cyan
Write-Host "  Get-Content '$PSScriptRoot\..\logs\tunnel.log' -Wait -Tail 20"
Write-Host ''
Write-Host 'Remove it:' -ForegroundColor Cyan
Write-Host "  .\tools\install-tunnel-task.ps1 -Remove"
