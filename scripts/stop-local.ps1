param([switch]$KeepInfra,[switch]$Docker)
$ErrorActionPreference='Stop'
$projectRoot=[IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$runtime=Join-Path $projectRoot '.runtime'
$jarPrefix=Join-Path $runtime 'app-'
$apps=Get-CimInstance Win32_Process -Filter "name = 'java.exe'" | Where-Object {$_.CommandLine -and $_.CommandLine.Contains($jarPrefix)}
foreach($app in $apps){Stop-Process -Id $app.ProcessId -ErrorAction SilentlyContinue}
$metaPath=Join-Path $runtime 'processes.json'
if(Test-Path -LiteralPath $metaPath){
 $meta=Get-Content -LiteralPath $metaPath -Raw | ConvertFrom-Json
 if($meta.root -eq $projectRoot){$gateway=Get-CimInstance Win32_Process -Filter ("ProcessId = "+$meta.gateway);if($gateway -and $gateway.Name -eq 'node.exe' -and $gateway.CommandLine -match 'scripts[\\/]gateway\.mjs'){Stop-Process -Id $gateway.ProcessId -ErrorAction SilentlyContinue}}
}
if(-not $KeepInfra){
 if($Docker){Push-Location $projectRoot;try{& docker compose stop}finally{Pop-Location}}else{
  $redis=Join-Path $runtime 'redis\Redis-7.4.3-Windows-x64-cygwin\redis-cli.exe'
  if(Test-Path -LiteralPath $redis){$listen=Get-NetTCPConnection -State Listen -LocalPort 56379 -ErrorAction SilentlyContinue;if($listen){$redisPid=($listen|Select-Object -First 1).OwningProcess;$proc=Get-CimInstance Win32_Process -Filter "ProcessId = $redisPid";if($proc.ExecutablePath -and $proc.ExecutablePath.StartsWith($runtime,[StringComparison]::OrdinalIgnoreCase)){& $redis -h 127.0.0.1 -p 56379 SHUTDOWN SAVE}}}
  $ctl=Join-Path $runtime 'postgres\bin\pg_ctl.exe'
  if(Test-Path -LiteralPath $ctl){& $ctl -D (Join-Path $runtime 'pg-data') -m fast -w -t 15 stop}
 }
}
Write-Output 'Owned local processes stopped. Database files and Docker volumes preserved.'
