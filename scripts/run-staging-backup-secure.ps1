$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$backupDirectory = Join-Path $projectRoot 'backups\pre-0009'

Write-Host '=== STAGING DATABASE BACKUP (NO MIGRATION) ===' -ForegroundColor Cyan

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$form = New-Object System.Windows.Forms.Form
$form.Text = 'Supabase staging backup'
$form.Size = New-Object System.Drawing.Size(640, 285)
$form.StartPosition = 'CenterScreen'
$form.TopMost = $true

$label = New-Object System.Windows.Forms.Label
$label.Location = New-Object System.Drawing.Point(20, 18)
$label.Size = New-Object System.Drawing.Size(590, 42)
$label.Text = "Paste the Session pooler URI with [YOUR-PASSWORD] unchanged.`r`nThe database password is entered separately and is never saved."
$form.Controls.Add($label)

$connectionInput = New-Object System.Windows.Forms.TextBox
$connectionInput.Location = New-Object System.Drawing.Point(20, 68)
$connectionInput.Size = New-Object System.Drawing.Size(590, 24)
$form.Controls.Add($connectionInput)

$passwordLabel = New-Object System.Windows.Forms.Label
$passwordLabel.Location = New-Object System.Drawing.Point(20, 104)
$passwordLabel.Size = New-Object System.Drawing.Size(590, 22)
$passwordLabel.Text = 'Database password:'
$form.Controls.Add($passwordLabel)

$passwordInput = New-Object System.Windows.Forms.TextBox
$passwordInput.Location = New-Object System.Drawing.Point(20, 128)
$passwordInput.Size = New-Object System.Drawing.Size(590, 24)
$passwordInput.UseSystemPasswordChar = $true
$form.Controls.Add($passwordInput)

$startButton = New-Object System.Windows.Forms.Button
$startButton.Location = New-Object System.Drawing.Point(430, 172)
$startButton.Size = New-Object System.Drawing.Size(180, 34)
$startButton.Text = 'Start backup'
$startButton.DialogResult = [System.Windows.Forms.DialogResult]::OK
$form.AcceptButton = $startButton
$form.Controls.Add($startButton)

$cancelButton = New-Object System.Windows.Forms.Button
$cancelButton.Location = New-Object System.Drawing.Point(320, 172)
$cancelButton.Size = New-Object System.Drawing.Size(100, 34)
$cancelButton.Text = 'Cancel'
$cancelButton.DialogResult = [System.Windows.Forms.DialogResult]::Cancel
$form.CancelButton = $cancelButton
$form.Controls.Add($cancelButton)

$connectionInput.Select()
$dialogResult = $form.ShowDialog()
if ($dialogResult -ne [System.Windows.Forms.DialogResult]::OK) {
    throw 'Backup was cancelled before connecting to the database.'
}

$connectionString = $connectionInput.Text
$databasePassword = $passwordInput.Text
$connectionInput.Text = ''
$passwordInput.Text = ''
$form.Dispose()

try {
    if ([string]::IsNullOrWhiteSpace($connectionString) -or
        $connectionString -notmatch '^postgres(?:ql)?://' -or
        $connectionString -notlike '*[[]YOUR-PASSWORD[]]*') {
        throw 'Use the Session pooler URI and keep [YOUR-PASSWORD] unchanged.'
    }

    if ([string]::IsNullOrWhiteSpace($databasePassword)) {
        throw 'Database password is empty.'
    }

    $encodedPassword = [Uri]::EscapeDataString($databasePassword)
    $connectionString = $connectionString.Replace('[YOUR-PASSWORD]', $encodedPassword)
    $databasePassword = $null
    $encodedPassword = $null

    New-Item -ItemType Directory -Force -Path $backupDirectory | Out-Null

    $backupJobs = @(
        @{ File = 'roles.sql';  Arguments = @('--role-only') },
        @{ File = 'schema.sql'; Arguments = @() },
        @{ File = 'data.sql';   Arguments = @('--use-copy', '--data-only', '-x', 'storage.buckets_vectors', '-x', 'storage.vector_indexes') }
    )

    foreach ($job in $backupJobs) {
        $outputPath = Join-Path $backupDirectory $job.File
        Write-Host "Creating $($job.File)..." -ForegroundColor Cyan

        $arguments = @(
            'supabase', 'db', 'dump',
            '--db-url', $connectionString,
            '-f', $outputPath
        ) + $job.Arguments

        # Supabase CLI writes normal progress messages to stderr. Windows
        # PowerShell must not turn those messages into terminating errors.
        $previousErrorActionPreference = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        $commandOutput = & npx.cmd @arguments 2>&1
        $commandExitCode = $LASTEXITCODE
        $ErrorActionPreference = $previousErrorActionPreference
        $commandOutput | ForEach-Object { Write-Host $_ }
        if ($commandExitCode -ne 0) {
            $safeOutput = ($commandOutput | Out-String).Replace($connectionString, '[REDACTED_DATABASE_URL]')
            $safeOutput = $safeOutput -replace 'postgres(?:ql)?://\S+', '[REDACTED_DATABASE_URL]'
            Set-Content -LiteralPath (Join-Path $backupDirectory 'backup-last-error.log') -Value $safeOutput
            throw "Backup failed while creating $($job.File) (exit code $commandExitCode)."
        }

        $createdFile = Get-Item -LiteralPath $outputPath
        if ($createdFile.Length -le 0) {
            throw "Backup file $($job.File) is empty."
        }
    }

    Write-Host ''
    Write-Host 'BACKUP COMPLETED SUCCESSFULLY' -ForegroundColor Green
    Get-ChildItem -LiteralPath $backupDirectory -File |
        Select-Object Name, Length, LastWriteTime |
        Format-Table -AutoSize
}
catch {
    Write-Host ''
    Write-Host "BACKUP FAILED: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host 'A sanitized diagnostic was saved to backups\pre-0009\backup-last-error.log.' -ForegroundColor Yellow
    Read-Host 'Press Enter to close this window'
    exit 1
}
finally {
    $connectionString = $null
    $databasePassword = $null
    $encodedPassword = $null
}
