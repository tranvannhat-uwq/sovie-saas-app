$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$migrationDirectory = Join-Path $projectRoot 'migrations'
$migrationFile = Join-Path $migrationDirectory '0013_legacy_cashbook_customer_and_order_compatibility.sql'
$migration0014File = Join-Path $migrationDirectory '0014_sales_return_variable_conflict_fix.sql'
$integrationFile = Join-Path $migrationDirectory 'tests\phase6_legacy_compatibility_integration.sql'
$backupDirectory = Join-Path $projectRoot 'backups\pre-0009'
$docker = 'C:\Program Files\Docker\Docker\resources\bin\docker.exe'
$postgresImage = 'public.ecr.aws/supabase/postgres:17.6.1.156'

function Invoke-PsqlContainer {
    param([Parameter(Mandatory)] [string[]] $Arguments)
    $oldPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $output = & $docker run --rm -e PGPASSWORD -e PGSSLMODE `
        -v "${migrationDirectory}:/migration:ro" $postgresImage psql @Arguments 2>&1
    $exitCode = $LASTEXITCODE
    $ErrorActionPreference = $oldPreference
    [pscustomobject]@{ ExitCode = $exitCode; Output = @($output) }
}

function Read-StagingConnection {
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing
    $form = New-Object System.Windows.Forms.Form
    $form.Text = 'Apply migrations 0013-0014 - STAGING ONLY'
    $form.Size = New-Object System.Drawing.Size(680, 350)
    $form.StartPosition = 'CenterScreen'
    $form.TopMost = $true

    $message = New-Object System.Windows.Forms.Label
    $message.Location = New-Object System.Drawing.Point(20, 15)
    $message.Size = New-Object System.Drawing.Size(630, 48)
    $message.Text = "Paste the Session pooler URI and keep [YOUR-PASSWORD].`r`nThis script runs only after explicit STAGING confirmation."
    $form.Controls.Add($message)

    $uriInput = New-Object System.Windows.Forms.TextBox
    $uriInput.Location = New-Object System.Drawing.Point(20, 70)
    $uriInput.Size = New-Object System.Drawing.Size(630, 24)
    $form.Controls.Add($uriInput)

    $passwordLabel = New-Object System.Windows.Forms.Label
    $passwordLabel.Location = New-Object System.Drawing.Point(20, 110)
    $passwordLabel.Size = New-Object System.Drawing.Size(630, 22)
    $passwordLabel.Text = 'Database password (masked and kept only in memory):'
    $form.Controls.Add($passwordLabel)

    $passwordInput = New-Object System.Windows.Forms.TextBox
    $passwordInput.Location = New-Object System.Drawing.Point(20, 136)
    $passwordInput.Size = New-Object System.Drawing.Size(630, 24)
    $passwordInput.UseSystemPasswordChar = $true
    $form.Controls.Add($passwordInput)

    $confirmation = New-Object System.Windows.Forms.CheckBox
    $confirmation.Location = New-Object System.Drawing.Point(20, 178)
    $confirmation.Size = New-Object System.Drawing.Size(630, 32)
    $confirmation.Text = 'I confirm this is STAGING, not the live production database.'
    $form.Controls.Add($confirmation)

    $cancel = New-Object System.Windows.Forms.Button
    $cancel.Location = New-Object System.Drawing.Point(350, 230)
    $cancel.Size = New-Object System.Drawing.Size(100, 38)
    $cancel.Text = 'Cancel'
    $cancel.DialogResult = [System.Windows.Forms.DialogResult]::Cancel
    $form.Controls.Add($cancel)

    $apply = New-Object System.Windows.Forms.Button
    $apply.Location = New-Object System.Drawing.Point(460, 230)
    $apply.Size = New-Object System.Drawing.Size(190, 38)
    $apply.Text = 'Apply 0013-0014 on staging'
    $apply.DialogResult = [System.Windows.Forms.DialogResult]::OK
    $form.Controls.Add($apply)
    $form.AcceptButton = $apply
    $form.CancelButton = $cancel

    if ($form.ShowDialog() -ne [System.Windows.Forms.DialogResult]::OK) {
        $form.Dispose()
        throw 'Cancelled before connecting.'
    }
    $answer = [pscustomobject]@{
        UriTemplate = $uriInput.Text.Trim()
        Password = $passwordInput.Text
        Confirmed = $confirmation.Checked
    }
    $uriInput.Text = ''
    $passwordInput.Text = ''
    $form.Dispose()
    $answer
}

Write-Host '=== MIGRATIONS 0013-0014 - STAGING ONLY ===' -ForegroundColor Cyan
try {
    if (-not (Test-Path -LiteralPath $migrationFile) -or
        -not (Test-Path -LiteralPath $migration0014File) -or
        -not (Test-Path -LiteralPath $integrationFile)) {
        throw 'Migration 0013, migration 0014, or the integration test is missing.'
    }
    foreach ($backupName in @('schema.sql', 'data.sql')) {
        $backupPath = Join-Path $backupDirectory $backupName
        if (-not (Test-Path -LiteralPath $backupPath) -or
            (Get-Item -LiteralPath $backupPath).Length -le 0) {
            throw "A required backup is missing or empty: $backupPath"
        }
    }
    if (-not (Test-Path -LiteralPath $docker)) { throw 'Docker Desktop is not installed at the expected location.' }

    $connection = Read-StagingConnection
    if (-not $connection.Confirmed) { throw 'STAGING was not confirmed. No changes were made.' }
    if ($connection.UriTemplate -notmatch '^postgres(?:ql)?://' -or
        $connection.UriTemplate -notlike '*[[]YOUR-PASSWORD[]]*' -or
        $connection.UriTemplate -notmatch '@[^/]*\.pooler\.supabase\.com:5432/') {
        throw 'Use the Session pooler URI on port 5432 and keep [YOUR-PASSWORD].'
    }
    if ([string]::IsNullOrWhiteSpace($connection.Password)) { throw 'Database password is empty.' }

    $parsed = [Uri]$connection.UriTemplate.Replace('[YOUR-PASSWORD]', 'placeholder')
    $databaseUser = ($parsed.UserInfo -split ':', 2)[0]
    $databaseName = $parsed.AbsolutePath.Trim('/')
    $env:PGPASSWORD = $connection.Password
    $env:PGSSLMODE = 'require'
    $connection.Password = $null
    $common = @('--host', $parsed.Host, '--port', $parsed.Port.ToString(),
        '--username', $databaseUser, '--dbname', $databaseName, '--set', 'ON_ERROR_STOP=1')

    $prerequisite = Invoke-PsqlContainer ($common + @('--tuples-only', '--no-align', '--command',
        "SELECT EXISTS (SELECT 1 FROM public.schema_migrations WHERE version = '0012');"))
    if ($prerequisite.ExitCode -ne 0 -or ($prerequisite.Output | Out-String) -notmatch '(?m)^t\s*$') {
        throw 'Migration 0012 is missing on staging. Stopped to preserve migration order.'
    }

    $state = Invoke-PsqlContainer ($common + @('--tuples-only', '--no-align', '--command',
        "SELECT EXISTS (SELECT 1 FROM public.schema_migrations WHERE version = '0013');"))
    if ($state.ExitCode -ne 0) { throw 'Could not read the migration registry.' }
    if (($state.Output | Out-String) -match '(?m)^t\s*$') {
        Write-Host '0013 is already applied; skipping re-application.' -ForegroundColor Yellow
    } else {
        $applyResult = Invoke-PsqlContainer ($common + @('--file', '/migration/0013_legacy_cashbook_customer_and_order_compatibility.sql'))
        $applyResult.Output | ForEach-Object { Write-Host $_ }
        if ($applyResult.ExitCode -ne 0) { throw "Migration 0013 failed (exit code $($applyResult.ExitCode))." }
    }

    $verify = Invoke-PsqlContainer ($common + @('--tuples-only', '--no-align', '--command', @"
SELECT CASE WHEN
  EXISTS (SELECT 1 FROM public.schema_migrations WHERE version = '0013')
  AND to_regprocedure('public.rpc_cancel_cashbook_entry(text,text)') IS NOT NULL
  AND to_regprocedure('public.p13_classify_cashbook(text)') IS NOT NULL
  AND to_regprocedure('public.rpc_cancel_order(text,text)') IS NOT NULL
  AND EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='cashbook_transactions' AND column_name='operation_type')
THEN 'MIGRATION_0013_VERIFIED' ELSE 'MIGRATION_0013_INCOMPLETE' END;
"@))
    $verify.Output | ForEach-Object { Write-Host $_ }
    if ($verify.ExitCode -ne 0 -or ($verify.Output | Out-String) -notmatch 'MIGRATION_0013_VERIFIED') {
        throw 'Migration 0013 verification failed.'
    }

    $state0014 = Invoke-PsqlContainer ($common + @('--tuples-only', '--no-align', '--command',
        "SELECT EXISTS (SELECT 1 FROM public.schema_migrations WHERE version = '0014');"))
    if ($state0014.ExitCode -ne 0) { throw 'Could not read migration 0014 state.' }
    if (($state0014.Output | Out-String) -match '(?m)^t\s*$') {
        Write-Host '0014 is already applied; skipping re-application.' -ForegroundColor Yellow
    } else {
        Write-Host 'Applying sales-return conflict fix 0014...' -ForegroundColor Cyan
        $apply0014 = Invoke-PsqlContainer ($common + @('--file', '/migration/0014_sales_return_variable_conflict_fix.sql'))
        $apply0014.Output | ForEach-Object { Write-Host $_ }
        if ($apply0014.ExitCode -ne 0) { throw "Migration 0014 failed (exit code $($apply0014.ExitCode))." }
    }

    $verify0014 = Invoke-PsqlContainer ($common + @('--tuples-only', '--no-align', '--command', @"
SELECT CASE WHEN
  EXISTS (SELECT 1 FROM public.schema_migrations WHERE version = '0014')
  AND EXISTS (
    SELECT 1 FROM pg_proc procedure
    JOIN pg_namespace namespace ON namespace.oid = procedure.pronamespace
    WHERE namespace.nspname='public'
      AND procedure.proname='rpc_record_sales_return'
      AND procedure.prosrc LIKE '%target_order_id text :=%'
      AND procedure.prosrc LIKE '%sale_source.id = target_order_id%'
  )
THEN 'MIGRATION_0014_VERIFIED' ELSE 'MIGRATION_0014_INCOMPLETE' END;
"@))
    $verify0014.Output | ForEach-Object { Write-Host $_ }
    if ($verify0014.ExitCode -ne 0 -or ($verify0014.Output | Out-String) -notmatch 'MIGRATION_0014_VERIFIED') {
        throw 'Migration 0014 verification failed.'
    }

    Write-Host 'Running integration tests (all fixtures roll back)...' -ForegroundColor Cyan
    $testResult = Invoke-PsqlContainer ($common + @('--file', '/migration/tests/phase6_legacy_compatibility_integration.sql'))
    $testResult.Output | ForEach-Object { Write-Host $_ }
    if ($testResult.ExitCode -ne 0) { throw "Integration test 0013 failed (exit code $($testResult.ExitCode))." }
    Write-Host ''
    Write-Host 'MIGRATIONS 0013-0014 AND INTEGRATION TESTS COMPLETED SUCCESSFULLY' -ForegroundColor Green
}
catch {
    Write-Host ''
    Write-Host "STOPPED: $($_.Exception.Message)" -ForegroundColor Red
    Read-Host 'Press Enter to close'
    exit 1
}
finally {
    $env:PGPASSWORD = $null
    $env:PGSSLMODE = $null
    $connection = $null
    $parsed = $null
}
