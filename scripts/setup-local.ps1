param([switch]$Docker)
$ErrorActionPreference='Stop'
$projectRoot=Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot
$runtime=Join-Path $projectRoot '.runtime'
New-Item -ItemType Directory -Path $runtime -Force | Out-Null
if($Docker){
 & docker compose up -d --wait
 if($LASTEXITCODE -ne 0){throw 'Docker Compose startup failed'}
}else{
 $pgBin=Join-Path $runtime 'postgres\bin'
 if(-not(Test-Path -LiteralPath (Join-Path $pgBin 'postgres.exe'))){
  $url='https://repo.maven.apache.org/maven2/io/zonky/test/postgres/embedded-postgres-binaries-windows-amd64/17.11.0/embedded-postgres-binaries-windows-amd64-17.11.0.jar'
  $archive=Join-Path $runtime 'postgres.jar'
  Invoke-WebRequest -Uri $url -OutFile $archive
  if((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -ne '98040FAE18DD9633FF95932125B0CECF0A45A1A9312E216E2A33AD03A31D4251'){throw 'PostgreSQL archive checksum mismatch'}
  New-Item -ItemType Directory -Path (Join-Path $runtime 'pg-archive'),(Join-Path $runtime 'postgres') -Force | Out-Null
  & tar -xf $archive -C (Join-Path $runtime 'pg-archive')
  & tar -xf (Join-Path $runtime 'pg-archive\postgres-windows-x86_64.txz') -C (Join-Path $runtime 'postgres')
  if($LASTEXITCODE -ne 0){throw 'PostgreSQL extraction failed'}
 }
 $redisDir=Join-Path $runtime 'redis\Redis-7.4.3-Windows-x64-cygwin'
 if(-not(Test-Path -LiteralPath (Join-Path $redisDir 'redis-server.exe'))){
  $archive=Join-Path $runtime 'redis.zip'
  Invoke-WebRequest -Uri 'https://github.com/redis-windows/redis-windows/releases/download/7.4.3/Redis-7.4.3-Windows-x64-cygwin.zip' -OutFile $archive
  if((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -ne 'F6FE3DBBEA180672FE08CBA80759168EA68A51CD7EE4F097E1B8905A053D0AD1'){throw 'Redis archive checksum mismatch'}
  Expand-Archive -LiteralPath $archive -DestinationPath (Join-Path $runtime 'redis') -Force
 }
 $pgData=Join-Path $runtime 'pg-data'
 if(-not(Test-Path -LiteralPath (Join-Path $pgData 'PG_VERSION'))){& (Join-Path $pgBin 'initdb.exe') -D $pgData -U loginlab -A trust --encoding=UTF8 --locale=C;if($LASTEXITCODE -ne 0){throw 'initdb failed'}}
 & (Join-Path $pgBin 'pg_ctl.exe') -D $pgData status *> $null
 if($LASTEXITCODE -ne 0){& (Join-Path $pgBin 'pg_ctl.exe') -D $pgData -l (Join-Path $runtime 'postgres.log') -o '-h 127.0.0.1 -p 55432' -w -t 15 start;if($LASTEXITCODE -ne 0){throw 'PostgreSQL startup failed'}}
 $existing=Get-NetTCPConnection -State Listen -LocalPort 56379 -ErrorAction SilentlyContinue
 if(-not $existing){
  $data=Join-Path $runtime 'redis-data'
  New-Item -ItemType Directory -Path $data -Force | Out-Null
  $drive=$data.Substring(0,1).ToLowerInvariant()
  $unixPath='/cygdrive/'+$drive+($data.Substring(2).Replace('\','/'))
  Start-Process -FilePath (Join-Path $redisDir 'redis-server.exe') -ArgumentList @('--bind','127.0.0.1','--port','56379','--dir',$unixPath,'--appendonly','yes','--loglevel','warning') -WorkingDirectory $redisDir -WindowStyle Hidden -RedirectStandardOutput (Join-Path $runtime 'redis-out.log') -RedirectStandardError (Join-Path $runtime 'redis-error.log')
 }else{
  $existingPid=($existing | Select-Object -First 1).OwningProcess
  $process=Get-CimInstance Win32_Process -Filter "ProcessId = $existingPid"
  if($process.ExecutablePath -ne (Join-Path $redisDir 'redis-server.exe')){throw 'Port 56379 is used by another process'}
 }
 & (Join-Path $pgBin 'postgres.exe') --version
 & (Join-Path $redisDir 'redis-server.exe') --version
}
if(-not(Test-Path -LiteralPath (Join-Path $runtime 'dev-key.pem'))){
 $openssl='C:\Program Files\Git\usr\bin\openssl.exe'
 if(-not(Test-Path -LiteralPath $openssl)){$openssl=(Get-Command openssl -ErrorAction Stop).Source}
 & $openssl req -x509 -newkey rsa:2048 -nodes -keyout (Join-Path $runtime 'dev-key.pem') -out (Join-Path $runtime 'dev-cert.pem') -subj '/CN=localhost' -addext 'subjectAltName=DNS:localhost,IP:127.0.0.1' -days 30
 if($LASTEXITCODE -ne 0){throw 'Local HTTPS certificate generation failed'}
}
& node scripts/init-db.mjs
if($LASTEXITCODE -ne 0){throw 'Project database setup failed'}
Write-Output 'Local infrastructure ready. PostgreSQL:55432 Redis:56379'
