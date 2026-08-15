param(
  [Parameter(Mandatory = $true)]
  [string]$BackupDirectory
)

$ErrorActionPreference = 'Stop'

if (-not $env:PHASE6_TARGET_DATABASE_URL) {
  throw 'Set PHASE6_TARGET_DATABASE_URL to the NEW staging Postgres connection string.'
}
if ($env:PHASE6_RESTORE_CONFIRM -ne 'RESTORE_NEW_STAGING') {
  throw 'Set PHASE6_RESTORE_CONFIRM=RESTORE_NEW_STAGING after verifying the target is a new staging project.'
}
foreach ($commandName in @('psql', 'pg_restore')) {
  if (-not (Get-Command $commandName -ErrorAction SilentlyContinue)) {
    throw "$commandName is required. Install the PostgreSQL client matching the server major version."
  }
}

$resolvedBackupDirectory = [System.IO.Path]::GetFullPath($BackupDirectory)
if (-not (Test-Path -LiteralPath $resolvedBackupDirectory -PathType Container)) {
  throw "Backup directory does not exist: $resolvedBackupDirectory"
}

$manifest = Get-ChildItem -LiteralPath $resolvedBackupDirectory -Filter '*.sha256' -File |
  Sort-Object LastWriteTime -Descending |
  Select-Object -First 1
$dump = Get-ChildItem -LiteralPath $resolvedBackupDirectory -Filter '*.full.dump' -File |
  Sort-Object LastWriteTime -Descending |
  Select-Object -First 1
if (-not $manifest -or -not $dump -or $dump.Length -le 0) {
  throw 'A non-empty *.full.dump and matching *.sha256 manifest are required.'
}

$expectedHashes = @{}
Get-Content -LiteralPath $manifest.FullName | ForEach-Object {
  if ($_ -match '^([0-9a-fA-F]{64})\s+(.+)$') {
    $expectedHashes[$Matches[2].Trim()] = $Matches[1].ToLowerInvariant()
  }
}
$dumpName = $dump.Name
if (-not $expectedHashes.ContainsKey($dumpName)) {
  throw "Checksum manifest does not contain $dumpName."
}
$actualHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $dump.FullName).Hash.ToLowerInvariant()
if ($actualHash -ne $expectedHashes[$dumpName]) {
  throw "Checksum mismatch for $dumpName. Restore stopped."
}

$publicTableCount = & psql $env:PHASE6_TARGET_DATABASE_URL -v ON_ERROR_STOP=1 -Atc "select count(*) from information_schema.tables where table_schema = 'public';"
if ($LASTEXITCODE -ne 0) { throw 'Could not inspect the target staging database.' }
if ([int]$publicTableCount -ne 0) {
  throw "Target public schema is not empty ($publicTableCount tables). Use a NEW staging project; no tables were changed."
}

Write-Host 'Checksum verified. Target public schema is empty.' -ForegroundColor Green
Write-Host "Restoring $dumpName into the confirmed NEW staging database..." -ForegroundColor Cyan
& pg_restore --exit-on-error --no-owner --no-privileges --dbname=$env:PHASE6_TARGET_DATABASE_URL $dump.FullName
if ($LASTEXITCODE -ne 0) { throw 'pg_restore failed.' }

$verification = & psql $env:PHASE6_TARGET_DATABASE_URL -v ON_ERROR_STOP=1 -Atc @"
select 'public_tables=' || count(*) from information_schema.tables where table_schema = 'public';
select 'schema_migrations=' || count(*) from public.schema_migrations;
select 'customers=' || count(*) from public.customers;
select 'orders=' || count(*) from public.orders;
select 'customer_debt_transactions=' || count(*) from public.customer_debt_transactions;
select 'cashbook_transactions=' || count(*) from public.cashbook_transactions;
"@
if ($LASTEXITCODE -ne 0) { throw 'Restore completed but verification queries failed.' }

Write-Host 'PHASE 6 STAGING RESTORE COMPLETED' -ForegroundColor Green
$verification | ForEach-Object { Write-Host $_ }
Write-Host 'Do not point production traffic at this database. Run migrations and integration/E2E tests first.' -ForegroundColor Yellow

