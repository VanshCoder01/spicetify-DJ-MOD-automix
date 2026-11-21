# Builds the release files into dist\:
#   dist\djmix\                    the Spicetify custom app (app\* + djmix.js), ready to drop into CustomApps
#   dist\DJMix-App-<ver>.zip       the same folder zipped, for manual installs / macOS / Linux
#   dist\djmix.js                  the extension on its own (Marketplace / old-style installs)
#   dist\DJMix-Setup-<ver>.exe     the Windows installer wizard (needs Inno Setup 6)
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

$ver = (Select-String -Path djmix.js -Pattern '^// VERSION:\s*(\S+)').Matches[0].Groups[1].Value
Write-Host "DJ Mix $ver" -ForegroundColor Green

$dist = Join-Path $PSScriptRoot "dist"
if (Test-Path $dist) { Remove-Item -Recurse -Force $dist }
$stage = Join-Path $dist "djmix"
New-Item -ItemType Directory -Force $stage | Out-Null
Copy-Item app\manifest.json, app\index.js, app\style.css, djmix.js $stage
Copy-Item djmix.js $dist
Compress-Archive -Path $stage -DestinationPath (Join-Path $dist "DJMix-App-$ver.zip")

$iscc = @(
  "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe",
  "$env:ProgramFiles\Inno Setup 6\ISCC.exe",
  "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $iscc) {
  Write-Warning "Inno Setup 6 not found; skipping the installer. Get it from https://jrsoftware.org/isdl.php"
} else {
  & $iscc /Qp "/DAppVersion=$ver" installer\djmix.iss
  if ($LASTEXITCODE -ne 0) { throw "Installer compile failed" }
}
Get-ChildItem $dist -File | ForEach-Object { "{0,-32} {1,8:N0} KB" -f $_.Name, ($_.Length / 1KB) }
