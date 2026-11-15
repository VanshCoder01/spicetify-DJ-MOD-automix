# Copies djmix.js into Spicetify's extensions folder, enables it, and re-applies (restarts Spotify).
$dest = Join-Path $env:APPDATA "spicetify\Extensions"
New-Item -ItemType Directory -Force $dest | Out-Null
Copy-Item -Force (Join-Path $PSScriptRoot "djmix.js") $dest

$enabled = (spicetify config extensions) -split '\|'
if ($enabled -notcontains "djmix.js") { spicetify config extensions djmix.js }

spicetify apply
