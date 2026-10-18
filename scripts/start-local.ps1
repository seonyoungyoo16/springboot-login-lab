param([switch]$Docker,[switch]$SkipBuild)
$ErrorActionPreference='Stop'
$projectRoot=Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot
$existing=Get-NetTCPConnection -State Listen -LocalPort 8460 -ErrorAction SilentlyContinue
if($existing){throw 'The lab is already running. Stop it with scripts/stop-local.ps1 -KeepInfra before rebuilding.'}
if(-not(Test-Path -LiteralPath 'node_modules')){& npm ci;if($LASTEXITCODE -ne 0){throw 'npm ci failed'}}
& (Join-Path $PSScriptRoot 'setup-local.ps1') -Docker:$Docker
if(-not $SkipBuild){
 & npm run source
 & npm run build
 if($LASTEXITCODE -ne 0){throw 'Frontend build failed'}
 & (Join-Path $PSScriptRoot 'maven.ps1') -f backend/pom.xml package
 if($LASTEXITCODE -ne 0){throw 'Backend package failed'}
}
$env:LOGINLAB_INFRA=if($Docker){'docker'}else{'portable'}
& node scripts/gateway.mjs
