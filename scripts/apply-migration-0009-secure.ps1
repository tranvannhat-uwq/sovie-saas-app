$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$backupDirectory = Join-Path $projectRoot 'backups\pre-0009'
$migrationDirectory = Join-Path $projectRoot 'migrations'
$migrationFile = Join-Path $migrationDirectory '0009_supplier_purchases_debt_and_payments.sql'
$compatibilityFile = Join-Path $migrationDirectory '0010_supplier_updated_at_compatibility.sql'
$orderConflictFile = Join-Path $migrationDirectory '0011_confirm_order_variable_conflict_fix.sql'
$phase5File = Join-Path $migrationDirectory '0012_phase5_reporting_kpi_payroll.sql'
$phase5IntegrationFile = Join-Path $migrationDirectory 'tests\phase5_reporting_payroll_integration.sql'
$integrationFile = Join-Path $migrationDirectory 'tests\phase4_supplier_purchases_integration.sql'
$orderIntegrationFile = Join-Path $migrationDirectory 'tests\phase1_order_pricing_integration.sql'
$profileIntegrationFile = Join-Path $migrationDirectory 'tests\p0_profile_auth_integration.sql'
$securityIntegrationFile = Join-Path $migrationDirectory 'tests\p0_security_integration.sql'
$phase2IntegrationFile = Join-Path $migrationDirectory 'tests\phase2_financial_reversals_integration.sql'
$phase3IntegrationFile = Join-Path $migrationDirectory 'tests\phase3_sales_returns_integration.sql'
$docker = 'C:\Program Files\Docker\Docker\resources\bin\docker.exe'
$postgresImage = 'public.ecr.aws/supabase/postgres:17.6.1.156'

function Invoke-PostgresContainer {
    param(
        [Parameter(Mandatory)] [string[]] $PsqlArguments,
        [Parameter(Mandatory)] [string] $Mount
    )

    $dockerArguments = @(
        'run', '--rm',
        '-e', 'PGPASSWORD',
        '-e', 'PGSSLMODE',
        '-v', $Mount,
        $postgresImage,
        'psql'
    ) + $PsqlArguments

    $previousPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $output = & $docker @dockerArguments 2>&1
    $exitCode = $LASTEXITCODE
    $ErrorActionPreference = $previousPreference

    [pscustomobject]@{
        ExitCode = $exitCode
        Output = @($output)
    }
}

function Show-ConnectionDialog {
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing

    $form = New-Object System.Windows.Forms.Form
    $form.Text = 'Apply staging migrations through 0012'
    $form.Size = New-Object System.Drawing.Size(660, 360)
    $form.StartPosition = 'CenterScreen'
    $form.TopMost = $true

    $warning = New-Object System.Windows.Forms.Label
    $warning.Location = New-Object System.Drawing.Point(20, 15)
    $warning.Size = New-Object System.Drawing.Size(610, 48)
    $warning.Text = "STAGING ONLY - applies pending migrations through 0012 and runs rollback-only tests.`r`nPaste the Session pooler URI with [YOUR-PASSWORD] unchanged."
    $form.Controls.Add($warning)

    $uriInput = New-Object System.Windows.Forms.TextBox
    $uriInput.Location = New-Object System.Drawing.Point(20, 70)
    $uriInput.Size = New-Object System.Drawing.Size(610, 24)
    $form.Controls.Add($uriInput)

    $passwordLabel = New-Object System.Windows.Forms.Label
    $passwordLabel.Location = New-Object System.Drawing.Point(20, 112)
    $passwordLabel.Size = New-Object System.Drawing.Size(610, 22)
    $passwordLabel.Text = 'Database password (masked and kept only in memory):'
    $form.Controls.Add($passwordLabel)

    $passwordInput = New-Object System.Windows.Forms.TextBox
    $passwordInput.Location = New-Object System.Drawing.Point(20, 138)
    $passwordInput.Size = New-Object System.Drawing.Size(610, 24)
    $passwordInput.UseSystemPasswordChar = $true
    $form.Controls.Add($passwordInput)

    $stagingConfirmation = New-Object System.Windows.Forms.CheckBox
    $stagingConfirmation.Location = New-Object System.Drawing.Point(20, 180)
    $stagingConfirmation.Size = New-Object System.Drawing.Size(610, 32)
    $stagingConfirmation.Text = 'I confirm this connection is STAGING, not the live production database.'
    $form.Controls.Add($stagingConfirmation)

    $applyButton = New-Object System.Windows.Forms.Button
    $applyButton.Location = New-Object System.Drawing.Point(430, 230)
    $applyButton.Size = New-Object System.Drawing.Size(200, 38)
    $applyButton.Text = 'Apply through 0012 on staging'
    $applyButton.DialogResult = [System.Windows.Forms.DialogResult]::OK
    $form.AcceptButton = $applyButton
    $form.Controls.Add($applyButton)

    $cancelButton = New-Object System.Windows.Forms.Button
    $cancelButton.Location = New-Object System.Drawing.Point(315, 230)
    $cancelButton.Size = New-Object System.Drawing.Size(105, 38)
    $cancelButton.Text = 'Cancel'
    $cancelButton.DialogResult = [System.Windows.Forms.DialogResult]::Cancel
    $form.CancelButton = $cancelButton
    $form.Controls.Add($cancelButton)

    $uriInput.Select()
    $result = $form.ShowDialog()
    if ($result -ne [System.Windows.Forms.DialogResult]::OK) {
        $form.Dispose()
        throw 'Migration was cancelled before connecting to staging.'
    }

    $values = [pscustomobject]@{
        UriTemplate = $uriInput.Text.Trim()
        Password = $passwordInput.Text
        StagingConfirmed = $stagingConfirmation.Checked
    }
    $uriInput.Text = ''
    $passwordInput.Text = ''
    $form.Dispose()
    $values
}

Write-Host '=== STAGING MIGRATIONS THROUGH 0012 ===' -ForegroundColor Cyan

try {
    foreach ($backupName in @('roles.sql', 'schema.sql', 'data.sql')) {
        $backupPath = Join-Path $backupDirectory $backupName
        if (-not (Test-Path -LiteralPath $backupPath) -or
            (Get-Item -LiteralPath $backupPath).Length -le 0) {
            throw "Required pre-0009 backup is missing or empty: $backupName"
        }
    }
    if (-not (Test-Path -LiteralPath $migrationFile)) {
        throw 'Migration 0009 file is missing.'
    }
    if (-not (Test-Path -LiteralPath $integrationFile)) {
        throw 'Phase 4 integration test file is missing.'
    }
    if (-not (Test-Path -LiteralPath $compatibilityFile)) {
        throw 'Migration 0010 compatibility file is missing.'
    }
    if (-not (Test-Path -LiteralPath $orderConflictFile)) {
        throw 'Migration 0011 order conflict fix is missing.'
    }
    if (-not (Test-Path -LiteralPath $phase5File) -or
        -not (Test-Path -LiteralPath $phase5IntegrationFile)) {
        throw 'Migration 0012 or its Phase 5 integration test is missing.'
    }
    if (-not (Test-Path -LiteralPath $orderIntegrationFile)) {
        throw 'Phase 1 order integration test file is missing.'
    }
    foreach ($requiredTest in @($profileIntegrationFile, $securityIntegrationFile,
        $phase2IntegrationFile, $phase3IntegrationFile)) {
        if (-not (Test-Path -LiteralPath $requiredTest)) {
            throw "Required integration test file is missing: $requiredTest"
        }
    }
    if (-not (Test-Path -LiteralPath $docker)) {
        throw 'Docker CLI is not installed.'
    }

    $connection = Show-ConnectionDialog
    if ($connection.UriTemplate -notmatch '^postgres(?:ql)?://' -or
        $connection.UriTemplate -notlike '*[[]YOUR-PASSWORD[]]*') {
        throw 'Use the Session pooler URI and keep [YOUR-PASSWORD] unchanged.'
    }
    if ($connection.UriTemplate -notmatch '@[^/]*\.pooler\.supabase\.com:5432/') {
        throw 'The URI must be a Supabase Session pooler connection on port 5432.'
    }
    if ([string]::IsNullOrWhiteSpace($connection.Password)) {
        throw 'Database password is empty.'
    }
    if (-not $connection.StagingConfirmed) {
        throw 'Staging confirmation was not checked. Production was not changed.'
    }

    $parseableUri = [Uri]$connection.UriTemplate.Replace('[YOUR-PASSWORD]', 'placeholder')
    $databaseUser = ($parseableUri.UserInfo -split ':', 2)[0]
    $databaseName = $parseableUri.AbsolutePath.Trim('/')
    if ([string]::IsNullOrWhiteSpace($databaseUser) -or
        [string]::IsNullOrWhiteSpace($databaseName)) {
        throw 'The Session pooler URI is incomplete.'
    }

    $env:PGPASSWORD = $connection.Password
    $env:PGSSLMODE = 'require'
    $connection.Password = $null

    $migrationMount = $migrationDirectory + ':/migration:ro'
    $commonArguments = @(
        '--host', $parseableUri.Host,
        '--port', $parseableUri.Port.ToString(),
        '--username', $databaseUser,
        '--dbname', $databaseName,
        '--set', 'ON_ERROR_STOP=1'
    )

    $stateResult = Invoke-PostgresContainer -Mount $migrationMount -PsqlArguments (
        $commonArguments + @('--tuples-only', '--no-align', '--command',
          "SELECT EXISTS (SELECT 1 FROM public.schema_migrations WHERE version = '0009');")
    )
    if ($stateResult.ExitCode -ne 0) {
        throw 'Could not read the staging migration registry.'
    }

    if (($stateResult.Output | Out-String) -match '(?m)^t\s*$') {
        Write-Host 'Migration 0009 is already applied; skipping re-application.' -ForegroundColor Yellow
    }
    else {
        Write-Host 'Applying migration 0009...' -ForegroundColor Cyan
        $migrationResult = Invoke-PostgresContainer -Mount $migrationMount -PsqlArguments (
            $commonArguments + @('--file', '/migration/0009_supplier_purchases_debt_and_payments.sql')
        )
        $migrationResult.Output | ForEach-Object { Write-Host $_ }
        if ($migrationResult.ExitCode -ne 0) {
            $safeLog = $migrationResult.Output | Out-String
            Set-Content -LiteralPath (Join-Path $backupDirectory 'migration-0009-last-error.log') -Value $safeLog
            throw "Migration 0009 failed (exit code $($migrationResult.ExitCode))."
        }
    }

    $compatibilityState = Invoke-PostgresContainer -Mount $migrationMount -PsqlArguments (
        $commonArguments + @('--tuples-only', '--no-align', '--command',
          "SELECT EXISTS (SELECT 1 FROM public.schema_migrations WHERE version = '0010');")
    )
    if ($compatibilityState.ExitCode -ne 0) {
        throw 'Could not read migration 0010 state.'
    }
    if (($compatibilityState.Output | Out-String) -match '(?m)^t\s*$') {
        Write-Host 'Migration 0010 is already applied; skipping re-application.' -ForegroundColor Yellow
    }
    else {
        Write-Host 'Applying compatibility migration 0010...' -ForegroundColor Cyan
        $compatibilityResult = Invoke-PostgresContainer -Mount $migrationMount -PsqlArguments (
            $commonArguments + @('--file', '/migration/0010_supplier_updated_at_compatibility.sql')
        )
        $compatibilityResult.Output | ForEach-Object { Write-Host $_ }
        if ($compatibilityResult.ExitCode -ne 0) {
            $safeLog = $compatibilityResult.Output | Out-String
            Set-Content -LiteralPath (Join-Path $backupDirectory 'migration-0010-last-error.log') -Value $safeLog
            throw "Migration 0010 failed (exit code $($compatibilityResult.ExitCode))."
        }
    }

    $orderConflictState = Invoke-PostgresContainer -Mount $migrationMount -PsqlArguments (
        $commonArguments + @('--tuples-only', '--no-align', '--command',
          "SELECT EXISTS (SELECT 1 FROM public.schema_migrations WHERE version = '0011');")
    )
    if ($orderConflictState.ExitCode -ne 0) {
        throw 'Could not read migration 0011 state.'
    }
    if (($orderConflictState.Output | Out-String) -match '(?m)^t\s*$') {
        Write-Host 'Migration 0011 is already applied; skipping re-application.' -ForegroundColor Yellow
    }
    else {
        Write-Host 'Applying order confirmation migration 0011...' -ForegroundColor Cyan
        $orderConflictResult = Invoke-PostgresContainer -Mount $migrationMount -PsqlArguments (
            $commonArguments + @('--file', '/migration/0011_confirm_order_variable_conflict_fix.sql')
        )
        $orderConflictResult.Output | ForEach-Object { Write-Host $_ }
        if ($orderConflictResult.ExitCode -ne 0) {
            $safeLog = $orderConflictResult.Output | Out-String
            Set-Content -LiteralPath (Join-Path $backupDirectory 'migration-0011-last-error.log') -Value $safeLog
            throw "Migration 0011 failed (exit code $($orderConflictResult.ExitCode))."
        }
    }

    $phase5State = Invoke-PostgresContainer -Mount $migrationMount -PsqlArguments (
        $commonArguments + @('--tuples-only', '--no-align', '--command',
          "SELECT EXISTS (SELECT 1 FROM public.schema_migrations WHERE version = '0012');")
    )
    if ($phase5State.ExitCode -ne 0) { throw 'Could not read migration 0012 state.' }
    if (($phase5State.Output | Out-String) -match '(?m)^t\s*$') {
        Write-Host 'Migration 0012 is already applied; skipping re-application.' -ForegroundColor Yellow
    }
    else {
        Write-Host 'Applying Phase 5 migration 0012...' -ForegroundColor Cyan
        $phase5Result = Invoke-PostgresContainer -Mount $migrationMount -PsqlArguments (
            $commonArguments + @('--file', '/migration/0012_phase5_reporting_kpi_payroll.sql')
        )
        $phase5Result.Output | ForEach-Object { Write-Host $_ }
        if ($phase5Result.ExitCode -ne 0) {
            Set-Content -LiteralPath (Join-Path $backupDirectory 'migration-0012-last-error.log') -Value ($phase5Result.Output | Out-String)
            throw "Migration 0012 failed (exit code $($phase5Result.ExitCode))."
        }
    }

    Write-Host 'Verifying migration registry and Phase 4/5 objects...' -ForegroundColor Cyan
    $verifySql = @"
SELECT CASE WHEN
  EXISTS (SELECT 1 FROM public.schema_migrations WHERE version = '0009')
  AND EXISTS (SELECT 1 FROM public.schema_migrations WHERE version = '0010')
  AND EXISTS (SELECT 1 FROM public.schema_migrations WHERE version = '0011')
  AND EXISTS (SELECT 1 FROM public.schema_migrations WHERE version = '0012')
  AND EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'suppliers'
      AND column_name = 'updated_at'
  )
  AND to_regclass('public.purchases') IS NOT NULL
  AND to_regclass('public.purchase_items') IS NOT NULL
  AND to_regclass('public.purchase_payments') IS NOT NULL
  AND to_regclass('public.supplier_debt_transactions') IS NOT NULL
  AND to_regprocedure('public.rpc_create_purchase(jsonb)') IS NOT NULL
  AND to_regprocedure('public.rpc_record_supplier_payment(jsonb)') IS NOT NULL
  AND to_regprocedure('public.rpc_cancel_supplier_payment(text,text)') IS NOT NULL
  AND to_regprocedure('public.rpc_cancel_purchase(text,text)') IS NOT NULL
  AND to_regclass('public.payroll_periods') IS NOT NULL
  AND to_regclass('public.payroll_entries') IS NOT NULL
  AND to_regprocedure('public.rpc_get_phase5_dashboard(jsonb)') IS NOT NULL
  AND to_regprocedure('public.rpc_get_payroll_period(text)') IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM pg_proc procedure
    JOIN pg_namespace namespace ON namespace.oid = procedure.pronamespace
    WHERE namespace.nspname = 'public'
      AND procedure.proname = 'rpc_confirm_order'
      AND procedure.prosrc LIKE '%#variable_conflict use_variable%'
      AND procedure.prosecdef
  )
THEN 'MIGRATION_0012_VERIFIED' ELSE 'MIGRATION_0012_INCOMPLETE' END;
"@
    $verifyResult = Invoke-PostgresContainer -Mount $migrationMount -PsqlArguments (
        $commonArguments + @('--tuples-only', '--no-align', '--command', $verifySql)
    )
    $verifyResult.Output | ForEach-Object { Write-Host $_ }
    if ($verifyResult.ExitCode -ne 0 -or
        ($verifyResult.Output | Out-String) -notmatch 'MIGRATION_0012_VERIFIED') {
        throw 'Migration registry or Phase 4/5 object verification failed.'
    }

    # This repair targets order confirmation. Other suites were already run in
    # this staging rollout, so only repeat the Phase 1 database path here.
    $databaseSuites = @(
        @{ Name = 'Phase 1 order'; File = '/migration/tests/phase1_order_pricing_integration.sql' },
        @{ Name = 'Phase 5 reporting and payroll'; File = '/migration/tests/phase5_reporting_payroll_integration.sql' }
    )
    foreach ($suite in $databaseSuites) {
        Write-Host "Running $($suite.Name) integration tests (fixtures roll back)..." -ForegroundColor Cyan
        $suiteResult = Invoke-PostgresContainer -Mount $migrationMount -PsqlArguments (
            $commonArguments + @('--file', $suite.File)
        )
        $suiteResult.Output | ForEach-Object { Write-Host $_ }
        if ($suiteResult.ExitCode -ne 0) {
            $safeName = ($suite.Name -replace '[^A-Za-z0-9]+', '-').ToLowerInvariant()
            $safeLog = $suiteResult.Output | Out-String
            Set-Content -LiteralPath (Join-Path $backupDirectory "integration-$safeName-last-error.log") -Value $safeLog
            throw "$($suite.Name) integration tests failed (exit code $($suiteResult.ExitCode))."
        }
    }

    Write-Host ''
    Write-Host 'STAGING MIGRATIONS 0009-0012 AND TESTS COMPLETED SUCCESSFULLY' -ForegroundColor Green
}
catch {
    Write-Host ''
    Write-Host "STOPPED: $($_.Exception.Message)" -ForegroundColor Red
    Read-Host 'Press Enter to close this window'
    exit 1
}
finally {
    $env:PGPASSWORD = $null
    $env:PGSSLMODE = $null
    $connection = $null
    $parseableUri = $null
}
