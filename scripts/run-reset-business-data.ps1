param([string]$DatabaseUrl = '')

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$resetSql = Join-Path $PSScriptRoot 'reset-business-data.sql'
$config = Get-Content -Raw -LiteralPath (Join-Path $projectRoot 'js\config.js')
$supabaseUrl = [regex]::Match($config, 'COMPANY_SUPABASE_URL\s*=\s*"([^"]+)"').Groups[1].Value
$projectRef = [regex]::Match($supabaseUrl, 'https://([^.]+)\.supabase\.co').Groups[1].Value
$confirmationText = 'DELETE_ALL_CASHBOOK_ORDERS_CUSTOMERS_PURCHASES'

Write-Host '=== BUSINESS DATA RESET ===' -ForegroundColor Red
Write-Host 'Deletes: customers, orders/drafts, returns, customer debt/payments, all cashbook rows, purchases and supplier payments.'
Write-Host 'Also deletes derived commission/payroll rows and resets supplier balances to zero.'
Write-Host 'Keeps: users/profiles, suppliers, products, brands, every price list and every price-list item.'
Write-Host 'Customer-linked price lists are detached, not deleted.'

if (-not (Test-Path -LiteralPath $resetSql)) { throw "Reset SQL is missing: $resetSql" }
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { throw 'Docker Desktop is required for the mandatory backup and reset.' }

function Test-DockerEngineReady {
  $previousPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'SilentlyContinue'
    docker info *> $null
    return $LASTEXITCODE -eq 0
  } finally {
    $ErrorActionPreference = $previousPreference
  }
}

if (-not (Test-DockerEngineReady)) {
  $dockerDesktopCandidates = @(
    (Join-Path $env:ProgramFiles 'Docker\Docker\Docker Desktop.exe'),
    (Join-Path $env:LOCALAPPDATA 'Docker\Docker Desktop.exe')
  ) | Where-Object { $_ -and (Test-Path -LiteralPath $_) }

  if ($dockerDesktopCandidates.Count -eq 0) {
    throw 'Docker Desktop is installed but its application could not be found. Open Docker Desktop manually, wait until it says Engine running, then run this script again.'
  }

  Write-Host 'Docker Engine is not running. Starting Docker Desktop...' -ForegroundColor Yellow
  Start-Process -FilePath $dockerDesktopCandidates[0] -WindowStyle Hidden

  $dockerReady = $false
  for ($attempt = 1; $attempt -le 60; $attempt++) {
    Start-Sleep -Seconds 2
    if (Test-DockerEngineReady) {
      $dockerReady = $true
      break
    }
    if ($attempt % 5 -eq 0) {
      Write-Host "Waiting for Docker Engine... $($attempt * 2)s" -ForegroundColor DarkYellow
    }
  }
  if (-not $dockerReady) {
    throw 'Docker Desktop did not become ready within 120 seconds. Open Docker Desktop, wait until Engine running, then run this script again.'
  }
  Write-Host 'Docker Engine is ready.' -ForegroundColor Green
}

if (-not $DatabaseUrl) { $DatabaseUrl = Read-Host 'Paste the Supabase Session pooler/database connection URI' }
if (-not $DatabaseUrl.StartsWith('postgresql://')) { throw 'A postgresql:// connection URI is required.' }
if (-not $projectRef -or $DatabaseUrl -notmatch [regex]::Escape($projectRef)) {
  throw "Connection refused: URI does not contain the application project ref $projectRef."
}

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
  $confirmation = Read-Host "Type exactly $confirmationText to continue"
  if ($confirmation -cne $confirmationText) { throw 'Reset cancelled: confirmation did not match.' }

  $timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $backupDirectory = Join-Path $projectRoot "backups\pre-business-reset-$timestamp"
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
      --command "SET app.reset_environment = 'PRODUCTION_APPROVED'; SET app.reset_confirmation = '$confirmationText';" `
      --file /workspace/scripts/reset-business-data.sql
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
