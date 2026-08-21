# CardVault backup, for Windows + Docker Desktop.
#
# Why a script rather than "Docker keeps a volume": a volume survives a container, and nothing
# else. It does not survive `docker compose down -v`, a bad migration, a disk failure, or the
# most likely accident by far - deleting the wrong thing while tidying up. A named volume is
# storage, not a backup.
#
#   .\tools\backup.ps1                     # dated dump + photos into .\backups
#   .\tools\backup.ps1 -Keep 30            # keep 30 instead of 14
#   .\tools\backup.ps1 -OutDir D:\backups  # ideally a different disk to the database
#   .\tools\backup.ps1 -SkipPhotos         # database only
#
# ---------------------------------------------------------------------------
# TWO THINGS ARE BACKED UP, BECAUSE THE DATA LIVES IN TWO PLACES
# ---------------------------------------------------------------------------
#
# The database holds everything except the photographs. The photographs are files in .\photos,
# deliberately outside the database so they survive a database wipe and can be opened in
# Explorer. That choice is only safe if the backup knows about both - a backup that silently
# covers half your data is worse than no backup, because you stop worrying about the half it
# misses. So this script takes the dump AND a zip of the photo folder, in one run, and refuses
# to report success unless both worked.
#
# ---------------------------------------------------------------------------
# One design decision worth explaining, because the obvious version is broken
# ---------------------------------------------------------------------------
#
# The tempting one-liner is:
#
#     docker compose exec -T db pg_dump -Fc | Out-File backup.dump
#
# and it produces a corrupt file every time. PowerShell captures a process's stdout as **text**,
# decoding bytes into a string with the console encoding and normalising line endings. A
# custom-format pg_dump is binary, so the bytes come out the other side changed - and the file
# still looks plausible, still has a sensible size, and fails only on the day you try to restore
# it. That is the worst possible failure mode for a backup.
#
# So the dump is written to a file INSIDE the container, verified there with `pg_restore --list`,
# and then copied out with `docker compose cp`, which moves bytes without interpreting them.
# Slightly more steps, no encoding in the path at all.

param(
  [string]$OutDir = "$PSScriptRoot\..\backups",
  [int]$Keep = 14,
  [string]$Service = 'db',
  [string]$User = 'cardvault',
  [string]$Database = 'cardvault',
  [string]$PhotoDir = "$PSScriptRoot\..\photos",
  [switch]$SkipPhotos
)

$ErrorActionPreference = 'Stop'

# PowerShell 5.1 turns native stderr into a terminating error under 'Stop', and docker writes
# ordinary progress to stderr. Every docker call has to be wrapped or the script dies on
# success. See docs/ARCHITECTURE.md, which records this costing a run.
function Invoke-Native {
  param([string]$Exe, [string[]]$Arguments)
  $old = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $out = & $Exe @Arguments 2>&1
    return @{ Code = $LASTEXITCODE; Output = ($out | Out-String).Trim() }
  } finally { $ErrorActionPreference = $old }
}

function Fail($msg, $detail) {
  if ($detail) { Write-Host $detail -ForegroundColor DarkGray }
  throw $msg
}

if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Path $OutDir -Force | Out-Null }
$OutDir = (Resolve-Path $OutDir).Path

$stamp    = Get-Date -Format 'yyyy-MM-dd_HHmm'
$name     = "cardvault_$stamp.dump"
$local    = Join-Path $OutDir $name
$inside   = "/tmp/$name"

Write-Host "Backing up $Database"

# --- 1. dump, inside the container ----------------------------------------
# -Fc: compressed custom format. Restorable selectively with pg_restore, and version-portable
# in a way a plain .sql of a specific server version is not.
$r = Invoke-Native 'docker' @('compose','exec','-T',$Service,
                              'pg_dump','-U',$User,'-d',$Database,'-Fc','-f',$inside)
if ($r.Code -ne 0) { Fail "pg_dump failed (exit $($r.Code))" $r.Output }

# --- 2. verify BEFORE copying out ----------------------------------------
# `pg_restore --list` parses the archive's table of contents without touching a database. It
# catches what actually goes wrong - a truncated file, an empty file, an error message saved
# under a .dump name - and it costs a second. It is not a restore test; only a restore is that.
$v = Invoke-Native 'docker' @('compose','exec','-T',$Service,
                              'sh','-c',"pg_restore --list $inside | wc -l")
if ($v.Code -ne 0) { Fail 'the dump is not a readable archive' $v.Output }
$entries = 0
[void][int]::TryParse(($v.Output -replace '\D',''), [ref]$entries)
if ($entries -lt 20) { Fail "the archive only lists $entries objects - that is not a full database" }

# The tables that matter must actually be in there. A dump of an empty schema would pass every
# check above, and 'holdings' is the one whose loss cannot be regenerated: the checklist can be
# reseeded from source, your collection cannot.
$t = Invoke-Native 'docker' @('compose','exec','-T',$Service,
                              'sh','-c',"pg_restore --list $inside | grep -c 'TABLE DATA public holdings'")
if (($t.Output -replace '\D','') -eq '0') {
  Write-Host '  warning: no holdings data in the dump. Fine if your collection is empty; alarming if not.' -ForegroundColor Yellow
}

# --- 3. copy out, as bytes -----------------------------------------------
$c = Invoke-Native 'docker' @('compose','cp',"${Service}:$inside",$local)
if ($c.Code -ne 0) { Fail 'could not copy the dump out of the container' $c.Output }
Invoke-Native 'docker' @('compose','exec','-T',$Service,'rm','-f',$inside) | Out-Null

if (-not (Test-Path $local)) { Fail 'the dump did not arrive on this machine' }
$size = (Get-Item $local).Length
if ($size -lt 20000) { Fail "the copied file is only $size bytes" }

# A custom-format archive starts with the five bytes "PGDMP". If those are wrong, something
# re-encoded the file on its way out - exactly the failure this script is shaped to avoid, so
# it is worth asserting rather than assuming.
$head  = [System.IO.File]::ReadAllBytes($local)[0..4]
$magic = -join ($head | ForEach-Object { [char]$_ })
if ($magic -ne 'PGDMP') { Fail "the file does not start with PGDMP (got '$magic') - it was corrupted in transit" }

Write-Host ("  ok: {0} KB, {1} objects, header verified" -f [math]::Round($size/1024), $entries) -ForegroundColor Green

# --- 4. the photographs ---------------------------------------------------
#
# Zipped from the host, not from inside a container: the folder is a bind mount, so Windows can
# read it directly and there is no encoding hazard the way there was with pg_dump's binary
# stdout. Compress-Archive is built into PowerShell 5.1, so nothing needs installing.
#
# JPEGs do not compress, so the zip is roughly the size of the folder. It exists for the
# grouping and the timestamp, not to save space - one file per backup, matching the dump beside
# it, so a restore is two obvious steps rather than a hunt.
$photoZip = $null
if (-not $SkipPhotos) {
  if (-not (Test-Path $PhotoDir)) {
    Write-Host '  no photo folder yet - nothing to back up' -ForegroundColor DarkGray
  } else {
    $files = @(Get-ChildItem $PhotoDir -Recurse -File -ErrorAction SilentlyContinue)
    if ($files.Count -eq 0) {
      Write-Host '  photo folder is empty - nothing to back up' -ForegroundColor DarkGray
    } else {
      $photoZip = Join-Path $OutDir "cardvault_${stamp}_photos.zip"
      $mb = [math]::Round((($files | Measure-Object Length -Sum).Sum) / 1MB, 1)
      Write-Host ("Backing up {0} photo(s), {1} MB" -f $files.Count, $mb)
      try {
        Compress-Archive -Path (Join-Path $PhotoDir '*') -DestinationPath $photoZip -Force
      } catch {
        Fail "could not zip the photo folder: $($_.Exception.Message)"
      }
      if (-not (Test-Path $photoZip)) { Fail 'the photo archive was not written' }

      # A zip starts with "PK". Same reasoning as the PGDMP check on the dump: assert the
      # thing you are relying on rather than trusting that it worked.
      $zhead = [System.IO.File]::ReadAllBytes($photoZip)[0..1]
      if ($zhead[0] -ne 0x50 -or $zhead[1] -ne 0x4B) { Fail 'the photo archive is not a zip file' }

      # And it must contain as many entries as the folder had files. A zip that silently
      # skipped a locked or long-path file would still open fine and still be missing photos.
      Add-Type -AssemblyName System.IO.Compression.FileSystem
      $zip = [System.IO.Compression.ZipFile]::OpenRead($photoZip)
      try { $inZip = @($zip.Entries | Where-Object { $_.Name -ne '' }).Count } finally { $zip.Dispose() }
      if ($inZip -lt $files.Count) {
        Fail "the archive holds $inZip of $($files.Count) photos - some were skipped"
      }
      Write-Host ("  ok: {0} KB, {1} photo(s) verified inside the zip" -f
                  [math]::Round((Get-Item $photoZip).Length/1024), $inZip) -ForegroundColor Green
    }
  }
} else {
  Write-Host '  photos skipped (-SkipPhotos)' -ForegroundColor Yellow
}

# --- 5. retention ---------------------------------------------------------
# The dump and its photo zip are deleted together, keyed on the same timestamp. Ageing them
# out independently would eventually leave a dump whose photos had already been removed - a
# backup that restores your collection with every picture missing.
$all = Get-ChildItem $OutDir -Filter 'cardvault_*.dump' | Sort-Object LastWriteTime -Descending
if ($all.Count -gt $Keep) {
  foreach ($f in ($all | Select-Object -Skip $Keep)) {
    $mate = $f.FullName -replace '\.dump$', '_photos.zip'
    Remove-Item $f.FullName -Force
    if (Test-Path $mate) { Remove-Item $mate -Force }
    Write-Host "  removed $($f.Name)"
  }
}
Write-Host ("  {0} backup(s) in {1}" -f [math]::Min($all.Count, $Keep), $OutDir)

Write-Host ''
Write-Host 'To restore - this DESTROYS the current database:' -ForegroundColor Yellow
Write-Host "  docker compose cp `"$local`" ${Service}:/tmp/restore.dump"
Write-Host "  docker compose exec -T $Service dropdb -U $User --if-exists $Database"
Write-Host "  docker compose exec -T $Service createdb -U $User $Database"
Write-Host "  docker compose exec -T $Service pg_restore -U $User -d $Database /tmp/restore.dump"
if ($photoZip) {
  Write-Host ''
  Write-Host 'And the photographs - restore these too, or every card comes back pictureless:' -ForegroundColor Yellow
  Write-Host "  Expand-Archive `"$photoZip`" -DestinationPath `"$PhotoDir`" -Force"
}
Write-Host ''
Write-Host 'Not scripted on purpose: a restore destroys what is there now, and a typo in an' -ForegroundColor DarkGray
Write-Host 'automated restore is how you lose the data the backup existed to protect.' -ForegroundColor DarkGray
