# Copies djmix.js into Spicetify's extensions folder, enables it, and re-applies (restarts Spotify).
$spicetify = (Get-Command spicetify -ErrorAction SilentlyContinue).Source
if (-not $spicetify) {
  # The installer puts the CLI here; it's only on PATH in shells opened after installing.
  $fallback = Join-Path $env:LOCALAPPDATA "spicetify\spicetify.exe"
  if (Test-Path $fallback) { $spicetify = $fallback }
  else { Write-Error "Spicetify not found. Install it from https://spicetify.app/docs/getting-started"; exit 1 }
}

$dest = Join-Path $env:APPDATA "spicetify\Extensions"
New-Item -ItemType Directory -Force $dest | Out-Null
Copy-Item -Force (Join-Path $PSScriptRoot "djmix.js") $dest

$enabled = (& $spicetify config extensions) -split '\|'
if ($enabled -notcontains "djmix.js") { & $spicetify config extensions djmix.js }

& $spicetify apply
