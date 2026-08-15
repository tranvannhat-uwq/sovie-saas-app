param([string]$DatabaseUrl = '')

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$resetSql = Join-Path $PSScriptRoot 'p6-reset-staging-test-data.sql'
$config = Get-Content -Raw -LiteralPath (Join-Path $projectRoot 'js\config.js')
$supabaseUrl = [regex]::Match($config, 'COMPANY_SUPABASE_URL\s*=\s*"([^"]+)"').Groups[1].Value
$projectRef = [regex]::Match($supabaseUrl, 'https://([^.]+)\.supabase\.co').Groups[1].Value

Write-Host '=== PHASE 6 STAGING TEST-DATA RESET ===' -ForegroundColor Cyan
Write-Host 'Keeps: Auth users/profiles, companies, brands, products/SKUs, price lists/items, migrations and audit logs.'
Write-Host 'Deletes: customers, orders/drafts, returns, payments, debt ledgers, cashbook, suppliers and purchases.'
Write-Host 'Warehouse/production legacy tables are not touched.'

if (-not (Test-Path -LiteralPath $resetSql)) { throw "Reset SQL is missing: $resetSql" }
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { throw 'Docker Desktop is required for the mandatory backup and reset.' }
docker info *> $null
if ($LASTEXITCODE -ne 0) { throw 'Docker Desktop is not running.' }

if (-not $DatabaseUrl) { $DatabaseUrl = Read-Host 'Paste the Supabase Session pooler/database connection URI' }
if (-not $DatabaseUrl.StartsWith('postgresql://')) { throw 'A postgresql:// connection URI is required.' }
if (-not $projectRef -or $DatabaseUrl -notmatch [regex]::Escape($projectRef)) {
  throw "Connection refused: URI does not contain the application project ref $projectRef."
}

# Supabase displays a URI template containing [YOUR-PASSWORD]. Always remove
# any URI password and use only the separately entered hidden PGPASSWORD.
$connectionUri = [regex]::Replace(
  $DatabaseUrl.Trim(),
  '^(postgresql://[^:/@]+):[^@]*@',
  '$1@'
)
if ($connectionUri -match '\[YOUR-PASSWORD\]' -or $connectionUri -match '://[^/@]+:[^@]+@') {
  throw 'Could not safely remove the password placeholder from the connection URI.'
}

$securePassword = Read-Host 'Database password (hidden)' -AsSecureString
$passwordPtr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
$databasePassword = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($passwordPtr)
try {
  $confirmation = Read-Host 'Type exactly DELETE_OPERATIONAL_TEST_DATA to continue'
  if ($confirmation -cne 'DELETE_OPERATIONAL_TEST_DATA') { throw 'Reset cancelled: confirmation did not match.' }

  $timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $backupDirectory = Join-Path $projectRoot "backups\pre-p6-reset-$timestamp"
  New-Item -ItemType Directory -Force -Path $backupDirectory | Out-Null
  $dockerBackupPath = $backupDirectory.Replace('\', '/')

  Write-Host "Backing up schema and data to $backupDirectory ..." -ForegroundColor Yellow
  docker run --rm -e "PGPASSWORD=$databasePassword" -e PGSSLMODE=require `
    -v "${dockerBackupPath}:/backup" postgres:17 `
    pg_dump --dbname $connectionUri --schema-only --no-owner --no-acl --file /backup/schema.sql
  if ($LASTEXITCODE -ne 0) { throw 'Schema backup failed; no data was deleted.' }
  docker run --rm -e "PGPASSWORD=$databasePassword" -e PGSSLMODE=require `
    -v "${dockerBackupPath}:/backup" postgres:17 `
    pg_dump --dbname $connectionUri --data-only --no-owner --no-acl --file /backup/data.sql
  if ($LASTEXITCODE -ne 0) { throw 'Data backup failed; no data was deleted.' }

  $schemaBackup = Join-Path $backupDirectory 'schema.sql'
  $dataBackup = Join-Path $backupDirectory 'data.sql'
  if ((Get-Item $schemaBackup).Length -eq 0 -or (Get-Item $dataBackup).Length -eq 0) {
    throw 'Backup verification failed; no data was deleted.'
  }

  $dockerProjectPath = $projectRoot.Replace('\', '/')
  Write-Host 'Backup verified. Running guarded transactional reset...' -ForegroundColor Yellow
  docker run --rm -e "PGPASSWORD=$databasePassword" -e PGSSLMODE=require `
    -v "${dockerProjectPath}:/workspace" postgres:17 `
    psql --dbname $connectionUri --set ON_ERROR_STOP=1 `
      --command "SET app.reset_environment = 'STAGING_ONLY'; SET app.reset_confirmation = 'DELETE_OPERATIONAL_TEST_DATA';" `
      --file /workspace/scripts/p6-reset-staging-test-data.sql
  if ($LASTEXITCODE -ne 0) { throw 'Reset failed and its SQL transaction was rolled back. Review the output above.' }

  Write-Host 'RESET COMPLETED SUCCESSFULLY' -ForegroundColor Green
  Write-Host "Recovery backup: $backupDirectory" -ForegroundColor Green
} finally {
  if ($passwordPtr -ne [IntPtr]::Zero) {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($passwordPtr)
  }
  $databasePassword = $null
}

Read-Host 'Press Enter to close'
