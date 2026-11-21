# DJ Mix setup helper. The installer wizard runs this; you can also run it by hand.
#   -Action install    register the DJ Mix app with Spicetify and apply (installs Spicetify first if -InstallSpicetify)
#   -Action repair     re-apply Spicetify, e.g. after a Spotify update wiped it
#   -Action uninstall  unregister DJ Mix and re-apply
param(
  [ValidateSet("install", "repair", "uninstall")] [string] $Action = "install",
  [switch] $InstallSpicetify,
  [string] $Log = (Join-Path $env:TEMP "djmix-setup.log")
)
$ErrorActionPreference = "Continue"
$app = "djmix"

function Write-Step($msg) {
  $line = "[{0:HH:mm:ss}] {1}" -f (Get-Date), $msg
  Write-Host $line -ForegroundColor Green
  Add-Content -Path $Log -Value $line
}
function Find-Spicetify {
  $cmd = Get-Command spicetify -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  foreach ($p in @("$env:LOCALAPPDATA\spicetify\spicetify.exe", "$env:USERPROFILE\spicetify-cli\spicetify.exe")) {
    if (Test-Path $p) { return $p }
  }
  return $null
}
# Runs spicetify with args, logs output, returns @{ ok; text }.
function Invoke-Spicetify([string[]] $argv) {
  Add-Content -Path $Log -Value "> spicetify $($argv -join ' ')"
  $out = & $script:sp @argv 2>&1 | Out-String
  $ok = $LASTEXITCODE -eq 0 -and $out -notmatch "(?im)^\s*(error|fatal)"
  Add-Content -Path $Log -Value $out
  Write-Host $out.Trim()
  return @{ ok = $ok; text = $out }
}
# apply, and if Spotify updated since the last backup, redo the backup.
function Invoke-Apply {
  Write-Step "Applying Spicetify (Spotify will restart)..."
  $r = Invoke-Spicetify @("apply", "-q")
  if ($r.ok) { return $true }
  Write-Step "Plain apply failed; Spotify probably updated. Re-creating Spicetify's backup..."
  $r = Invoke-Spicetify @("restore", "backup", "apply", "-q")
  if ($r.ok) { return $true }
  $r = Invoke-Spicetify @("backup", "apply", "-q")
  return $r.ok
}

Set-Content -Path $Log -Value "DJ Mix setup: $Action  $(Get-Date)"
$script:sp = Find-Spicetify

if (-not $script:sp -and $Action -eq "install" -and $InstallSpicetify) {
  Write-Step "Installing Spicetify from spicetify.app (answer its questions in this window)..."
  try {
    Invoke-WebRequest -UseBasicParsing "https://raw.githubusercontent.com/spicetify/cli/main/install.ps1" | Invoke-Expression
  } catch {
    Write-Step "Spicetify install failed: $_"
  }
  $script:sp = Find-Spicetify
}
if (-not $script:sp) {
  Write-Step "ERROR: Spicetify not found. Install it from https://spicetify.app, then run this installer again."
  exit 2
}
Write-Step "Using Spicetify at $script:sp"

$root = Join-Path $env:APPDATA "spicetify"
$customApps = Join-Path $root "CustomApps"

switch ($Action) {
  "install" {
    # Old standalone extension (v0.5 and earlier): the app now carries djmix.js itself, so remove the duplicate.
    $exts = ((Invoke-Spicetify @("config", "extensions")).text -split "[|\r\n]") | ForEach-Object { $_.Trim() }
    if ($exts -contains "djmix.js") {
      Write-Step "Removing the old standalone djmix.js extension (the app includes it now)..."
      Invoke-Spicetify @("config", "extensions", "djmix.js-") | Out-Null
    }
    $old = Join-Path $root "Extensions\djmix.js"
    if (Test-Path $old) { Remove-Item -Force $old }

    if (-not (Test-Path (Join-Path $customApps "$app\index.js"))) {
      Write-Step "ERROR: app files are missing from $customApps\$app"
      exit 3
    }
    $apps = ((Invoke-Spicetify @("config", "custom_apps")).text -split "[|\r\n]") | ForEach-Object { $_.Trim() }
    if ($apps -notcontains $app) {
      Write-Step "Adding DJ Mix to Spotify's sidebar..."
      Invoke-Spicetify @("config", "custom_apps", $app) | Out-Null
    }
    if (-not (Invoke-Apply)) { Write-Step "ERROR: spicetify apply failed. See $Log"; exit 4 }
    Write-Step "Done. Open Spotify and click DJ Mix in the sidebar."
  }
  "repair" {
    if (-not (Invoke-Apply)) { Write-Step "ERROR: repair failed. See $Log"; exit 4 }
    Write-Step "Repaired. DJ Mix is back in Spotify."
  }
  "uninstall" {
    Write-Step "Removing DJ Mix from Spicetify..."
    Invoke-Spicetify @("config", "custom_apps", "$app-") | Out-Null
    Invoke-Spicetify @("config", "extensions", "djmix.js-") | Out-Null
    Invoke-Apply | Out-Null
    Write-Step "DJ Mix removed."
  }
}
exit 0
