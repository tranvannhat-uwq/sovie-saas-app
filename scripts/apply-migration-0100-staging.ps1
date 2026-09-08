[CmdletBinding()]
param(
    [string] $DatabaseUrl = $env:STAGING_DATABASE_URL
)

$ErrorActionPreference = 'Stop'

# This repair changes only the staging control-plane schema. The database
# password is requested interactively and is never written to disk or logs.
$projectRoot = Split-Path -Parent $PSScriptRoot
$migrationFile = Join-Path $projectRoot 'migrations\0100_manual_trial_activation.sql'
$docker = 'C:\Program Files\Docker\Docker\resources\bin\docker.exe'
$postgresImage = 'public.ecr.aws/supabase/postgres:17.6.1.156'
$stagingProjectRef = 'mqxqswwssmemkimnolfu'

function Invoke-StagingPsql {
    param([Parameter(Mandatory)] [string[]] $Arguments)

    $previousPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $output = & $docker run --rm -e PGPASSWORD -e PGSSLMODE `
        -v "${projectRoot}:/workspace:ro" $postgresImage psql @Arguments 2>&1
    $exitCode = $LASTEXITCODE
    $ErrorActionPreference = $previousPreference
    [pscustomobject]@{ ExitCode = $exitCode; Output = @($output) }
}

function Read-RequiredValue {
    param([Parameter(Mandatory)] [string] $Prompt)

    $value = Read-Host $Prompt
    if ([string]::IsNullOrWhiteSpace($value)) {
        throw "$Prompt is required."
    }
    $value.Trim()
}

if (-not (Test-Path -LiteralPath $migrationFile)) {
    throw "Missing migration file: $migrationFile"
}
if (-not (Test-Path -LiteralPath $docker)) {
    throw 'Docker Desktop is required to run the pinned Postgres client image.'
}

if ([string]::IsNullOrWhiteSpace($DatabaseUrl)) {
    $DatabaseUrl = Read-RequiredValue 'Paste the STAGING Session pooler or direct Postgres URI (keep [YOUR-PASSWORD])'
}
if ($DatabaseUrl -notmatch '\[YOUR-PASSWORD\]') {
    throw 'Use a connection URI containing [YOUR-PASSWORD]; do not put the password in a command or environment variable.'
}

$uriForParsing = $DatabaseUrl.Replace('[YOUR-PASSWORD]', 'placeholder')
if ($uriForParsing -notmatch '^postgres(?:ql)?://') {
    throw 'The database URI must start with postgres:// or postgresql://.'
}

try {
    $parsed = [Uri] $uriForParsing
} catch {
    throw 'The database URI is not valid.'
}

$databaseUser = ($parsed.UserInfo -split ':', 2)[0]
$isDirectStaging = $parsed.Host -eq "db.$stagingProjectRef.supabase.co" -and $databaseUser -eq 'postgres'
$isPoolerStaging = $parsed.Host -like '*.pooler.supabase.com' -and $databaseUser -like "*.$stagingProjectRef"
if (-not ($isDirectStaging -or $isPoolerStaging)) {
    throw "Stopped: the URI does not identify the approved staging project $stagingProjectRef."
}

$confirmation = Read-RequiredValue "Type $stagingProjectRef to confirm this is STAGING"
if ($confirmation -cne $stagingProjectRef) {
    throw 'Staging confirmation did not match. No changes were made.'
}

$securePassword = Read-Host 'Database password' -AsSecureString
$passwordPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
try {
    $env:PGPASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($passwordPointer)
    $env:PGSSLMODE = 'require'
    $common = @(
        '--host', $parsed.Host,
        '--port', $parsed.Port.ToString(),
        '--username', $databaseUser,
        '--dbname', $parsed.AbsolutePath.Trim('/'),
        '--set', 'ON_ERROR_STOP=1'
    )

    $preflight = Invoke-StagingPsql ($common + @('--tuples-only', '--no-align', '--command', @"
SELECT CASE WHEN EXISTS (
  SELECT 1 FROM public.schema_migrations WHERE version = '0082'
) THEN 'PREREQUISITE_0082_OK' ELSE 'PREREQUISITE_0082_MISSING' END;
"@))
    if ($preflight.ExitCode -ne 0 -or ($preflight.Output | Out-String) -notmatch 'PREREQUISITE_0082_OK') {
        throw 'Migration 0082 is required before 0100. No changes were made.'
    }

    $state = Invoke-StagingPsql ($common + @('--tuples-only', '--no-align', '--command',
        "SELECT EXISTS (SELECT 1 FROM public.schema_migrations WHERE version = '0100');"))
    if ($state.ExitCode -ne 0) {
        throw 'Unable to read the staging migration registry.'
    }
    if (($state.Output | Out-String) -notmatch '(?m)^t\s*$') {
        $applied = Invoke-StagingPsql ($common + @('--file', '/workspace/migrations/0100_manual_trial_activation.sql'))
        $applied.Output | ForEach-Object { Write-Host $_ }
        if ($applied.ExitCode -ne 0) {
            throw "Migration 0100 failed (exit code $($applied.ExitCode))."
        }
    } else {
        Write-Host 'Migration 0100 is already registered; running verification only.' -ForegroundColor Yellow
    }

    $reload = Invoke-StagingPsql ($common + @('--command', "NOTIFY pgrst, 'reload schema';"))
    if ($reload.ExitCode -ne 0) {
        throw 'Migration 0100 applied, but PostgREST schema reload failed. Do not use activation until this is resolved.'
    }

    $verification = Invoke-StagingPsql ($common + @('--tuples-only', '--no-align', '--command', @"
WITH definition AS (
  SELECT pg_get_functiondef('public.rpc_platform_manage_customer(uuid,text,text,integer,text,text)'::regprocedure) AS sql
)
SELECT CASE WHEN
  EXISTS (SELECT 1 FROM public.schema_migrations WHERE version = '0100')
  AND (SELECT sql LIKE '%''activate''%' AND sql LIKE '%customer_activated%' FROM definition)
  AND has_function_privilege('authenticated', 'public.rpc_platform_manage_customer(uuid,text,text,integer,text,text)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.rpc_platform_manage_customer(uuid,text,text,integer,text,text)', 'EXECUTE')
  AND EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.platform_customer_events'::regclass
      AND conname = 'platform_customer_events_event_type_check'
      AND pg_get_constraintdef(oid) LIKE '%customer_activated%'
  )
THEN 'MIGRATION_0100_VERIFIED' ELSE 'MIGRATION_0100_INCOMPLETE' END;
"@))
    $verification.Output | ForEach-Object { Write-Host $_ }
    if ($verification.ExitCode -ne 0 -or ($verification.Output | Out-String) -notmatch 'MIGRATION_0100_VERIFIED') {
        throw 'Migration 0100 verification failed. Do not use activation until it is corrected.'
    }

    Write-Host 'Migration 0100 is active on Supabase staging. Trial customers can now be activated.' -ForegroundColor Green
} finally {
    if ($passwordPointer -ne [IntPtr]::Zero) {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($passwordPointer)
    }
    $env:PGPASSWORD = $null
    $env:PGSSLMODE = $null
    $securePassword = $null
}
