$ErrorActionPreference = 'Stop'

$productionRef = 'coebrkerpcgwckkwxlfo'
$stagingRef = 'mqxqswwssmemkimnolfu'
$projectRoot = Split-Path -Parent $PSScriptRoot
$workDirectory = Join-Path $projectRoot 'backups\mobile-dashboard-transfer'

$psqlMode = if (Get-Command psql -ErrorAction SilentlyContinue) {
  'host'
} elseif (Get-Command docker -ErrorAction SilentlyContinue) {
  'docker'
} else {
  throw 'Either psql or Docker Desktop is required.'
}

if ($psqlMode -eq 'docker') {
  $previousPreference = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  $dockerStatus = & docker info --format '{{.ServerVersion}}' 2>&1
  $dockerStatusCode = $LASTEXITCODE
  $ErrorActionPreference = $previousPreference
  if ($dockerStatusCode -ne 0 -or [string]::IsNullOrWhiteSpace(($dockerStatus | Out-String))) {
    throw @"
Docker Desktop is installed but its engine is not running.
Open Docker Desktop, wait until it shows 'Engine running', then run this script again.
No connection to production or staging was opened and no data was changed.
"@
  }

  $previousPreference = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  & docker image inspect postgres:17-alpine *> $null
  $imageExistsCode = $LASTEXITCODE
  $ErrorActionPreference = $previousPreference
  if ($imageExistsCode -ne 0) {
    Write-Host 'Downloading PostgreSQL client image (first run only)...' -ForegroundColor Cyan
    $previousPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $pullOutput = & docker pull postgres:17-alpine 2>&1
    $pullCode = $LASTEXITCODE
    $ErrorActionPreference = $previousPreference
    $pullOutput | ForEach-Object { Write-Host $_ }
    if ($pullCode -ne 0) {
      throw 'Could not download postgres:17-alpine. Check Docker Desktop network access and try again.'
    }
  }
}

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

function Read-DatabaseConnection {
  param(
    [Parameter(Mandatory = $true)][string]$Title,
    [Parameter(Mandatory = $true)][string]$ExpectedProjectRef
  )

  $form = New-Object System.Windows.Forms.Form
  $form.Text = $Title
  $form.Size = New-Object System.Drawing.Size(680, 300)
  $form.StartPosition = 'CenterScreen'
  $form.TopMost = $true

  $label = New-Object System.Windows.Forms.Label
  $label.Location = New-Object System.Drawing.Point(20, 16)
  $label.Size = New-Object System.Drawing.Size(625, 42)
  $label.Text = "Paste the Session pooler URI for project $ExpectedProjectRef with [YOUR-PASSWORD] unchanged."
  $form.Controls.Add($label)

  $uriInput = New-Object System.Windows.Forms.TextBox
  $uriInput.Location = New-Object System.Drawing.Point(20, 68)
  $uriInput.Size = New-Object System.Drawing.Size(625, 24)
  $form.Controls.Add($uriInput)

  $passwordLabel = New-Object System.Windows.Forms.Label
  $passwordLabel.Location = New-Object System.Drawing.Point(20, 104)
  $passwordLabel.Size = New-Object System.Drawing.Size(625, 22)
  $passwordLabel.Text = 'Database password (never saved):'
  $form.Controls.Add($passwordLabel)

  $passwordInput = New-Object System.Windows.Forms.TextBox
  $passwordInput.Location = New-Object System.Drawing.Point(20, 130)
  $passwordInput.Size = New-Object System.Drawing.Size(625, 24)
  $passwordInput.UseSystemPasswordChar = $true
  $form.Controls.Add($passwordInput)

  $okButton = New-Object System.Windows.Forms.Button
  $okButton.Location = New-Object System.Drawing.Point(465, 178)
  $okButton.Size = New-Object System.Drawing.Size(180, 34)
  $okButton.Text = 'Continue'
  $okButton.DialogResult = [System.Windows.Forms.DialogResult]::OK
  $form.AcceptButton = $okButton
  $form.Controls.Add($okButton)

  $cancelButton = New-Object System.Windows.Forms.Button
  $cancelButton.Location = New-Object System.Drawing.Point(355, 178)
  $cancelButton.Size = New-Object System.Drawing.Size(100, 34)
  $cancelButton.Text = 'Cancel'
  $cancelButton.DialogResult = [System.Windows.Forms.DialogResult]::Cancel
  $form.CancelButton = $cancelButton
  $form.Controls.Add($cancelButton)

  $uriInput.Select()
  $result = $form.ShowDialog()
  if ($result -ne [System.Windows.Forms.DialogResult]::OK) {
    $form.Dispose()
    throw 'Transfer cancelled before a database connection was opened.'
  }

  $uriTemplate = $uriInput.Text.Trim()
  $databasePassword = $passwordInput.Text
  $uriInput.Text = ''
  $passwordInput.Text = ''
  $form.Dispose()

  if ([string]::IsNullOrWhiteSpace($uriTemplate) -or
      $uriTemplate -notmatch '^postgres(?:ql)?://' -or
      $uriTemplate -notlike '*[[]YOUR-PASSWORD[]]*') {
    throw 'Use the Session pooler URI and keep [YOUR-PASSWORD] unchanged.'
  }
  if ($uriTemplate -notmatch [regex]::Escape($ExpectedProjectRef)) {
    throw "Connection refused: URI does not contain expected project ref $ExpectedProjectRef."
  }
  if ([string]::IsNullOrWhiteSpace($databasePassword)) {
    throw 'Database password is empty.'
  }

  $encodedPassword = [Uri]::EscapeDataString($databasePassword)
  $connectionUri = $uriTemplate.Replace('[YOUR-PASSWORD]', $encodedPassword)
  $databasePassword = $null
  $encodedPassword = $null
  return $connectionUri
}

function Invoke-Psql {
  param(
    [Parameter(Mandatory = $true)][string]$DatabaseUrl,
    [Parameter(Mandatory = $true)][string[]]$Arguments,
    [switch]$SourceReadOnly
  )

  $previousPgOptions = $env:PGOPTIONS
  try {
    if ($SourceReadOnly) {
      $env:PGOPTIONS = '-c default_transaction_read_only=on -c statement_timeout=300000'
    }
    if ($psqlMode -eq 'host') {
      $output = & psql @Arguments --dbname=$DatabaseUrl 2>&1
    } else {
      $dockerArguments = @('run', '--rm')
      if ($env:PGOPTIONS) {
        $dockerArguments += @('--env', "PGOPTIONS=$($env:PGOPTIONS)")
      }
      if (Test-Path -LiteralPath $workDirectory -PathType Container) {
        $dockerArguments += @('--mount', "type=bind,source=$workDirectory,target=/work")
      }
      $dockerArguments += @('postgres:17-alpine', 'psql')
      $dockerArguments += $Arguments
      $dockerArguments += "--dbname=$DatabaseUrl"
      $previousPreference = $ErrorActionPreference
      $ErrorActionPreference = 'Continue'
      $output = & docker @dockerArguments 2>&1
      $dockerExitCode = $LASTEXITCODE
      $ErrorActionPreference = $previousPreference
    }
    $exitCode = if ($psqlMode -eq 'docker') { $dockerExitCode } else { $LASTEXITCODE }
    if ($exitCode -ne 0) {
      $safeOutput = ($output | Out-String).Replace($DatabaseUrl, '[REDACTED_DATABASE_URL]')
      $safeOutput = $safeOutput -replace 'postgres(?:ql)?://\S+', '[REDACTED_DATABASE_URL]'
      throw "psql failed (exit code $exitCode): $safeOutput"
    }
    return $output
  }
  finally {
    $env:PGOPTIONS = $previousPgOptions
  }
}

function Export-JsonTable {
  param(
    [Parameter(Mandatory = $true)][string]$DatabaseUrl,
    [Parameter(Mandatory = $true)][string]$TableName,
    [Parameter(Mandatory = $true)][string]$JsonExpression
  )

  $outputPath = Join-Path $workDirectory "$TableName.csv"
  $psqlPath = if ($psqlMode -eq 'docker') { "/work/$TableName.csv" } else { $outputPath.Replace('\', '/') }
  $copyCommand = "\copy (SELECT ($JsonExpression)::text AS payload FROM public.$TableName source_row) TO '$psqlPath' WITH (FORMAT csv, ENCODING 'UTF8')"
  Invoke-Psql -DatabaseUrl $DatabaseUrl -Arguments @('-X', '-v', 'ON_ERROR_STOP=1', '-c', $copyCommand) -SourceReadOnly | Out-Null
  if (-not (Test-Path -LiteralPath $outputPath)) {
    throw "Export did not create $outputPath."
  }
}

$productionUrl = $null
$stagingUrl = $null

try {
  Write-Host '=== MOBILE DASHBOARD: PRODUCTION -> ANONYMIZED STAGING ===' -ForegroundColor Cyan
  Write-Host 'Production is opened with PostgreSQL default_transaction_read_only=on.' -ForegroundColor Yellow
  Write-Host "PostgreSQL client mode: $psqlMode" -ForegroundColor DarkGray

  $productionUrl = Read-DatabaseConnection -Title 'Production database (READ ONLY)' -ExpectedProjectRef $productionRef
  $stagingUrl = Read-DatabaseConnection -Title 'Mobile staging database (WRITE TARGET)' -ExpectedProjectRef $stagingRef

  $productionIdentity = Invoke-Psql -DatabaseUrl $productionUrl -Arguments @('-X', '-At', '-v', 'ON_ERROR_STOP=1', '-c', "select current_database() || '|' || current_user") -SourceReadOnly
  $stagingIdentity = Invoke-Psql -DatabaseUrl $stagingUrl -Arguments @('-X', '-At', '-v', 'ON_ERROR_STOP=1', '-c', "select current_database() || '|' || current_user")
  Write-Host "Production connection verified: $productionIdentity" -ForegroundColor Green
  Write-Host "Staging connection verified: $stagingIdentity" -ForegroundColor Green

  $confirmation = Read-Host "Type exactly COPY_ANONYMIZED_DASHBOARD_TO_STAGING"
  if ($confirmation -cne 'COPY_ANONYMIZED_DASHBOARD_TO_STAGING') {
    throw 'Transfer cancelled: confirmation text did not match.'
  }

  if (Test-Path -LiteralPath $workDirectory) {
    $resolvedWork = [System.IO.Path]::GetFullPath($workDirectory)
    $resolvedRoot = [System.IO.Path]::GetFullPath($projectRoot)
    if (-not $resolvedWork.StartsWith($resolvedRoot + [System.IO.Path]::DirectorySeparatorChar)) {
      throw 'Refusing to clear a transfer directory outside the project.'
    }
    [System.IO.Directory]::Delete($resolvedWork, $true)
  }
  New-Item -ItemType Directory -Path $workDirectory -Force | Out-Null

  $plainTables = @(
    'companies', 'brands', 'product_groups', 'products', 'pricelists',
    'price_list_items', 'order_items'
  )
  foreach ($tableName in $plainTables) {
    Write-Host "Exporting anonymized-safe table $tableName..." -ForegroundColor Cyan
    Export-JsonTable -DatabaseUrl $productionUrl -TableName $tableName -JsonExpression 'to_jsonb(source_row)'
  }

  Write-Host 'Exporting anonymized customers...' -ForegroundColor Cyan
  Export-JsonTable -DatabaseUrl $productionUrl -TableName 'customers' -JsonExpression @"
to_jsonb(source_row) || jsonb_build_object(
  'name', 'Kh' || chr(225) || 'ch h' || chr(224) || 'ng ' || upper(substr(md5(source_row.id), 1, 8)),
  'phone', NULL, 'phone2', NULL, 'email', NULL, 'facebook', NULL,
  'birthday', NULL, 'gender', NULL, 'avatar_url', NULL,
  'address', NULL, 'invoice_address', NULL, 'company_name', NULL,
  'tax_code', NULL, 'notes', NULL
)
"@

  Write-Host 'Exporting anonymized orders...' -ForegroundColor Cyan
  Export-JsonTable -DatabaseUrl $productionUrl -TableName 'orders' -JsonExpression @"
to_jsonb(source_row) || jsonb_build_object(
  'customer_name', CASE WHEN source_row.customer_id IS NULL
    THEN 'Kh' || chr(225) || 'ch l' || chr(7867)
    ELSE 'Kh' || chr(225) || 'ch h' || chr(224) || 'ng ' || upper(substr(md5(source_row.customer_id), 1, 8)) END,
  'notes', NULL
)
"@

  $optionalExpressions = @{
    sales_returns = "to_jsonb(source_row) || jsonb_build_object('reason', 'D' || chr(7919) || ' li' || chr(7879) || 'u staging ' || chr(273) || chr(227) || ' ' || chr(7849) || 'n danh', 'notes', NULL)"
    payments = "to_jsonb(source_row) || jsonb_build_object('notes', NULL, 'description', NULL)"
    customer_debt_transactions = "to_jsonb(source_row) || jsonb_build_object('description', 'D' || chr(7919) || ' li' || chr(7879) || 'u staging ' || chr(273) || chr(227) || ' ' || chr(7849) || 'n danh', 'notes', NULL)"
  }
  foreach ($entry in $optionalExpressions.GetEnumerator()) {
    $exists = Invoke-Psql -DatabaseUrl $productionUrl -Arguments @('-X', '-At', '-v', 'ON_ERROR_STOP=1', '-c', "select to_regclass('public.$($entry.Key)') is not null") -SourceReadOnly
    if (($exists | Out-String).Trim() -eq 't') {
      Write-Host "Exporting anonymized $($entry.Key)..." -ForegroundColor Cyan
      Export-JsonTable -DatabaseUrl $productionUrl -TableName $entry.Key -JsonExpression $entry.Value
    }
  }

  $importSqlPath = Join-Path $workDirectory 'import.sql'
  $importLines = New-Object System.Collections.Generic.List[string]
  $importLines.Add('BEGIN;')
  $importLines.Add("SELECT set_config('app.mobile_dashboard_import', 'ANONYMIZED_STAGING_ONLY', true);")
  $importLines.Add("DO `$guard`$ BEGIN IF current_user <> 'postgres' THEN RAISE EXCEPTION 'Import requires database owner'; END IF; IF NOT EXISTS (SELECT 1 FROM public.schema_migrations WHERE version='0053') THEN RAISE EXCEPTION 'Migration 0053 is required'; END IF; END `$guard`$;")

  $importOrder = @(
    @{ Name='companies'; Conflict='id' },
    @{ Name='brands'; Conflict='name' },
    @{ Name='product_groups'; Conflict='id' },
    @{ Name='products'; Conflict='id' },
    @{ Name='pricelists'; Conflict='id' },
    @{ Name='price_list_items'; Conflict='id' },
    @{ Name='customers'; Conflict='id' },
    @{ Name='orders'; Conflict='id' },
    @{ Name='order_items'; Conflict='id' },
    @{ Name='sales_returns'; Conflict='id' },
    @{ Name='payments'; Conflict='id' },
    @{ Name='customer_debt_transactions'; Conflict='id' }
  )

  foreach ($table in $importOrder) {
    $csvPath = Join-Path $workDirectory "$($table.Name).csv"
    if (-not (Test-Path -LiteralPath $csvPath)) { continue }
    $psqlCsvPath = if ($psqlMode -eq 'docker') { "/work/$($table.Name).csv" } else { $csvPath.Replace('\', '/') }
    $importLines.Add('DROP TABLE IF EXISTS pg_temp.mobile_import_payload;')
    $importLines.Add('CREATE TEMP TABLE mobile_import_payload(payload jsonb);')
    $importLines.Add("\copy mobile_import_payload(payload) FROM '$psqlCsvPath' WITH (FORMAT csv, ENCODING 'UTF8')")
    $importLines.Add(@"
DO `$import`$
DECLARE
  column_names text;
  select_values text;
  update_values text;
BEGIN
  SELECT string_agg(format('%I', attribute.attname), ', ' ORDER BY attribute.attnum),
         string_agg(format('(jsonb_populate_record(NULL::public.%I, payload)).%I', '$($table.Name)', attribute.attname), ', ' ORDER BY attribute.attnum),
         string_agg(format('%I = EXCLUDED.%I', attribute.attname, attribute.attname), ', ' ORDER BY attribute.attnum)
           FILTER (WHERE attribute.attname <> '$($table.Conflict)')
  INTO column_names, select_values, update_values
  FROM pg_attribute attribute
  WHERE attribute.attrelid = 'public.$($table.Name)'::regclass
    AND attribute.attnum > 0 AND NOT attribute.attisdropped
    AND attribute.attgenerated = '' AND attribute.attidentity = '';

  EXECUTE format(
    'INSERT INTO public.%I (%s) SELECT %s FROM mobile_import_payload ON CONFLICT (%I) DO UPDATE SET %s',
    '$($table.Name)', column_names, select_values, '$($table.Conflict)', update_values
  );
END
`$import`$;
"@)
  }

  $importLines.Add("INSERT INTO public.audit_logs(table_name, action, record_id, new_data, performed_by, created_at) VALUES ('system', 'MOBILE_DASHBOARD_ANONYMIZED_IMPORT', to_char(clock_timestamp(), 'YYYYMMDDHH24MISSMS'), jsonb_build_object('source_project_ref', '$productionRef', 'contains_direct_customer_pii', false), 'database-owner:' || current_user, now());")
  $importLines.Add('COMMIT;')
  $importLines.Add("SELECT 'customers=' || count(*) FROM public.customers;")
  $importLines.Add("SELECT 'orders=' || count(*) FROM public.orders;")
  $importLines.Add("SELECT 'order_items=' || count(*) FROM public.order_items;")
  $importLines | Set-Content -LiteralPath $importSqlPath -Encoding utf8

  Write-Host 'Importing anonymized dashboard data into staging...' -ForegroundColor Cyan
  $psqlImportPath = if ($psqlMode -eq 'docker') { '/work/import.sql' } else { $importSqlPath }
  $importOutput = Invoke-Psql -DatabaseUrl $stagingUrl -Arguments @('-X', '-v', 'ON_ERROR_STOP=1', '--file', $psqlImportPath)
  $importOutput | ForEach-Object { Write-Host $_ }

  $verification = Invoke-Psql -DatabaseUrl $stagingUrl -Arguments @('-X', '-At', '-v', 'ON_ERROR_STOP=1', '-c', @"
select 'customers_with_contact_pii=' || count(*) from public.customers
where id not like 'STG-%' and (phone is not null or phone2 is not null or email is not null or tax_code is not null);
select 'finalized_orders=' || count(*) from public.orders where status not in ('cancelled','canceled','draft');
select 'dashboard_net_sales_90d=' || coalesce(sum(net_revenue), 0)
from public.orders
where coalesce(order_date, created_at) >= now() - interval '90 days'
  and coalesce(order_date, created_at) < now() + interval '1 day'
  and status not in ('cancelled', 'canceled', 'draft');
"@)
  Write-Host 'TRANSFER COMPLETED' -ForegroundColor Green
  $verification | ForEach-Object { Write-Host $_ }

  $resolvedWork = [System.IO.Path]::GetFullPath($workDirectory)
  [System.IO.Directory]::Delete($resolvedWork, $true)
  Write-Host 'Anonymized intermediate files were removed after successful verification.' -ForegroundColor Green
}
catch {
  Write-Host "TRANSFER FAILED: $($_.Exception.Message)" -ForegroundColor Red
  Write-Host "Anonymized intermediate files, if any, remain under: $workDirectory" -ForegroundColor Yellow
  exit 1
}
finally {
  $productionUrl = $null
  $stagingUrl = $null
}
