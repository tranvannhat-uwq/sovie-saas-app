param(
  [Parameter(Mandatory = $true)][string]$Email,
  [Parameter(Mandatory = $true)][string]$Password,
  [Parameter(Mandatory = $true)][ValidatePattern('^E2E-[0-9]{8}-[0-9]{6}$')][string]$RunId,
  [switch]$InspectOnly
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$config = Get-Content -Raw -LiteralPath (Join-Path $projectRoot 'js\config.js')
$baseUrl = [regex]::Match($config, 'COMPANY_SUPABASE_URL\s*=\s*"([^"]+)"').Groups[1].Value.TrimEnd('/')
$anonKey = [regex]::Match($config, 'COMPANY_SUPABASE_KEY\s*=\s*"([^"]+)"').Groups[1].Value
if (-not $baseUrl -or -not $anonKey) { throw 'Supabase configuration is missing.' }

function Invoke-Api([string]$Method, [string]$Path, $Body = $null) {
  $headers = @{ apikey = $anonKey; 'Content-Type' = 'application/json'; Prefer = 'return=representation' }
  if ($script:token) { $headers.Authorization = "Bearer $script:token" }
  $uri = if ($Path.StartsWith('/auth/')) { "$baseUrl$Path" } else { "$baseUrl/rest/v1/$Path" }
  $params = @{ Method = $Method; Uri = $uri; Headers = $headers }
  if ($null -ne $Body) { $params.Body = $Body | ConvertTo-Json -Depth 10 -Compress }
  Invoke-RestMethod @params
}

function ConvertTo-Rows($Result) {
  [object[]]$rows = if ($null -eq $Result) {
    @()
  } elseif ($Result.PSObject.Properties['value'] -and $Result.PSObject.Properties['Count']) {
    @($Result.value)
  } else {
    @($Result)
  }
  return ,$rows
}

$login = Invoke-Api POST '/auth/v1/token?grant_type=password' @{ email = $Email; password = $Password }
$script:token = $login.access_token
$profile = ConvertTo-Rows (Invoke-Api GET "profiles?select=role,is_active&auth_user_id=eq.$($login.user.id)")
if ($profile.Count -ne 1 -or $profile[0].role -notin @('admin', 'accounting') -or -not $profile[0].is_active) {
  throw "Reconciliation requires one active admin or accounting profile (rows=$($profile.Count), role=$($profile[0].role), active=$($profile[0].is_active))."
}

$paymentKey = "$RunId-customer-payment"
$payments = ConvertTo-Rows (Invoke-Api GET "cashbook_transactions?select=id,status,customer_id&idempotency_key=eq.$paymentKey")
$orders = ConvertTo-Rows (Invoke-Api GET "orders?select=id,status,customer_id,notes&notes=eq.$RunId")
if ($payments.Count -gt 1 -or $orders.Count -lt 1) {
  throw "Expected at most one payment and at least one order for $RunId; payment=$($payments.Count), order=$($orders.Count)."
}

$activeOrders = @($orders | Where-Object { $_.status -notin @('cancelled', 'canceled') })
if ($activeOrders.Count -gt 1) {
  throw "Refusing reconciliation because $RunId has $($activeOrders.Count) active orders."
}
$order = if ($activeOrders.Count -eq 1) { $activeOrders[0] } else { $orders[0] }
if ($InspectOnly) {
  [pscustomobject]@{ run_id = $RunId; payment = $payments; order = $order } | ConvertTo-Json -Depth 5
  exit 0
}
if ($payments.Count -eq 1 -and $payments[0].status -notin @('cancelled', 'canceled', 'Đã hủy', 'Da huy')) {
  try {
    Invoke-Api POST 'rpc/rpc_cancel_cashbook_entry' @{
      p_cashbook_id = $payments[0].id
      p_reason = "$RunId reconcile interrupted E2E payment"
    } | Out-Null
  } catch { throw "Failed to cancel payment $($payments[0].id): $($_.Exception.Message)" }
}
if ($order.status -notin @('cancelled', 'canceled')) {
  try {
    Invoke-Api POST 'rpc/rpc_cancel_order' @{
      p_order_id = $order.id
      p_reason = "$RunId reconcile interrupted E2E order"
    } | Out-Null
  } catch { throw "Failed to cancel order $($order.id): $($_.Exception.Message)" }
}

$customer = ConvertTo-Rows (Invoke-Api GET "customers?select=id,debt&id=eq.$($order.customer_id)")
if ($customer.Count -ne 1 -or [decimal]$customer[0].debt -ne 0) {
  throw "Reconciliation failed: resulting customer debt is $($customer[0].debt), expected 0."
}

[pscustomobject]@{
  run_id = $RunId
  order_id = $order.id
  payment_id = if ($payments.Count -eq 1) { $payments[0].id } else { $null }
  resulting_customer_debt = 0
  reconciled = $true
} | ConvertTo-Json
