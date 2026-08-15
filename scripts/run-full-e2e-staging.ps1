param(
  [Parameter(Mandatory = $true)][string]$AdminEmail,
  [Parameter(Mandatory = $true)][string]$AdminPassword,
  [Parameter(Mandatory = $true)][string]$AccountingEmail,
  [Parameter(Mandatory = $true)][string]$AccountingPassword,
  [Parameter(Mandatory = $true)][string]$SaleEmail,
  [Parameter(Mandatory = $true)][string]$SalePassword,
  [string]$RunId = ''
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$config = Get-Content -Raw -LiteralPath (Join-Path $projectRoot 'js\config.js')
$script:baseUrl = [regex]::Match($config, 'COMPANY_SUPABASE_URL\s*=\s*"([^"]+)"').Groups[1].Value.TrimEnd('/')
$script:anonKey = [regex]::Match($config, 'COMPANY_SUPABASE_KEY\s*=\s*"([^"]+)"').Groups[1].Value

if (-not $script:baseUrl -or -not $script:anonKey) {
  throw 'Supabase URL/anon key is missing from js/config.js.'
}

$script:results = [System.Collections.Generic.List[object]]::new()

function Add-Result([string]$Name, [bool]$Passed, [string]$Details) {
  $script:results.Add([pscustomobject]@{ test = $Name; passed = $Passed; details = $Details })
  if (-not $Passed) { throw "FAILED: $Name - $Details" }
}

function Invoke-JsonApi {
  param(
    [Parameter(Mandatory = $true)][ValidateSet('GET','POST','PATCH','DELETE')][string]$Method,
    [Parameter(Mandatory = $true)][string]$Path,
    [string]$Token,
    $Body,
    [switch]$AllowError
  )
  $headers = @{ apikey = $script:anonKey; 'Content-Type' = 'application/json'; Prefer = 'return=representation' }
  if ($Token) { $headers.Authorization = "Bearer $Token" }
  $uri = if ($Path.StartsWith('/auth/')) { "$($script:baseUrl)$Path" } else { "$($script:baseUrl)/rest/v1/$Path" }
  try {
    $params = @{ Method = $Method; Uri = $uri; Headers = $headers }
    if ($null -ne $Body) { $params.Body = ($Body | ConvertTo-Json -Depth 20 -Compress) }
    $data = Invoke-RestMethod @params
    return [pscustomobject]@{ ok = $true; status = 200; data = $data; error = $null }
  } catch {
    $status = 0
    if ($_.Exception.Response) { $status = [int]$_.Exception.Response.StatusCode }
    $message = if ($_.ErrorDetails.Message) { $_.ErrorDetails.Message } else { $_.Exception.Message }
    if ($_.Exception.Response) {
      try {
        $reader = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream())
        $responseBody = $reader.ReadToEnd()
        if ($responseBody) { $message = $responseBody }
      } catch {
        # Keep the original safe HTTP message when the response body is unavailable.
      }
    }
    if (-not $AllowError) { throw "HTTP $status $Method $Path - $message" }
    return [pscustomobject]@{ ok = $false; status = $status; data = $null; error = $message }
  }
}

function Login([string]$Email, [string]$Password, [string]$ExpectedRole) {
  $response = Invoke-JsonApi -Method POST -Path '/auth/v1/token?grant_type=password' -Body @{
    email = $Email; password = $Password
  }
  $token = $response.data.access_token
  $userId = $response.data.user.id
  Add-Result "auth_login_$ExpectedRole" ([bool]$token -and [bool]$userId) 'Supabase Auth returned a real user session.'
  $profile = Invoke-JsonApi -Method GET -Path "profiles?select=id,auth_user_id,role,is_active&auth_user_id=eq.$userId" -Token $token
  $rows = @($profile.data)
  Add-Result "profile_role_$ExpectedRole" ($rows.Count -eq 1 -and $rows[0].role -eq $ExpectedRole -and $rows[0].is_active) "Expected exactly one active $ExpectedRole profile."
  return [pscustomobject]@{ token = $token; userId = $userId; email = $Email; role = $ExpectedRole }
}

function Rpc($Session, [string]$Name, $Arguments, [switch]$AllowError) {
  return Invoke-JsonApi -Method POST -Path "rpc/$Name" -Token $Session.token -Body $Arguments -AllowError:$AllowError
}

function Read-Rows($Session, [string]$Path) {
  $response = Invoke-JsonApi -Method GET -Path $Path -Token $Session.token
  Write-Output -NoEnumerate @($response.data)
}

function Customer-Debt($Session, [string]$CustomerId) {
  $rows = Read-Rows $Session "customers?select=debt&id=eq.$CustomerId"
  if ($rows.Count -ne 1) { throw "Customer $CustomerId was not found." }
  return [decimal]$rows[0].debt
}

function Assert-Decimal([string]$Name, $Actual, $Expected) {
  $actualValue = [decimal]$Actual
  $expectedValue = [decimal]$Expected
  Add-Result $Name ($actualValue -eq $expectedValue) "actual=$actualValue expected=$expectedValue"
}

$runId = if ($RunId) { $RunId } else { 'E2E-' + (Get-Date -Format 'yyyyMMdd-HHmmss') }
$testTimestamp = (Get-Date).ToUniversalTime().Date.ToString('o')
$admin = Login $AdminEmail $AdminPassword 'admin'
$accounting = Login $AccountingEmail $AccountingPassword 'accounting'
$sale = Login $SaleEmail $SalePassword 'sale'

# Authorization probes use real JWTs and make no business changes.
$saleProfiles = Read-Rows $sale 'profiles?select=id&limit=1000'
Add-Result 'sale_reads_only_own_profile' ($saleProfiles.Count -eq 1) "visible_profiles=$($saleProfiles.Count)"
$saleCashbook = Read-Rows $sale 'cashbook_transactions?select=id&limit=1'
Add-Result 'sale_cannot_read_cashbook' ($saleCashbook.Count -eq 0) "visible_rows=$($saleCashbook.Count)"
$saleAudit = Read-Rows $sale 'audit_logs?select=id&limit=1'
Add-Result 'sale_cannot_read_audit_log' ($saleAudit.Count -eq 0) "visible_rows=$($saleAudit.Count)"
$anonCustomers = Invoke-JsonApi -Method GET -Path 'customers?select=id&limit=1' -AllowError
Add-Result 'anon_cannot_read_customers' (-not $anonCustomers.ok -or @($anonCustomers.data).Count -eq 0) "http_status=$($anonCustomers.status)"

# Discover one sale-enabled list and a positive-priced active SKU from the live catalogue.
$publicLists = Read-Rows $admin 'pricelists?select=id,name,price_list_type,is_available_for_sales,customer_id,is_active&is_active=eq.true&is_available_for_sales=eq.true&customer_id=is.null&limit=100'
$chosenList = $null
$chosenItem = $null
$chosenProduct = $null
foreach ($list in $publicLists) {
  if (@('dealer_private','customer_specific','customer') -contains $list.price_list_type) { continue }
  $items = Read-Rows $admin "price_list_items?select=product_id,variant_id,price&price_list_id=eq.$($list.id)&price=gt.0&limit=20"
  foreach ($item in $items) {
    $productId = if ($item.variant_id) { $item.variant_id } else { $item.product_id }
    $products = Read-Rows $admin "products?select=id,code,name,is_active&id=eq.$productId&is_active=eq.true"
    if ($products.Count -eq 1) {
      $chosenList = $list; $chosenItem = $item; $chosenProduct = $products[0]; break
    }
  }
  if ($chosenProduct) { break }
}
Add-Result 'catalogue_has_orderable_sku' ($null -ne $chosenProduct) "price_list=$($chosenList.name) sku=$($chosenProduct.code)"

$privateLists = Read-Rows $admin 'pricelists?select=id,price_list_type,is_available_for_sales,customer_id&limit=100'
$privateList = $privateLists | Where-Object {
  $_.customer_id -or $_.is_available_for_sales -ne $true -or @('dealer_private','customer_specific','customer') -contains $_.price_list_type
} | Select-Object -First 1
Add-Result 'catalogue_has_restricted_pricelist' ($null -ne $privateList) "restricted_list=$($privateList.id)"

# Admin creates an isolated customer assigned to the Sale test account.
$customerId = $runId.ToLowerInvariant() + '-customer'
$customerInsert = Invoke-JsonApi -Method POST -Path 'customers' -Token $admin.token -Body @{
  id = $customerId
  code = $runId
  name = "$runId Customer"
  phone = '0900000000'
  address = 'Staging E2E only'
  notes = $runId
  pricelist_id = $chosenList.id
  default_price_list_id = $chosenList.id
  managed_by = $sale.email
  status = 'active'
}
Add-Result 'admin_creates_customer' (@($customerInsert.data).Count -eq 1) "customer_id=$customerId"
Assert-Decimal 'customer_starts_at_zero_debt' (Customer-Debt $accounting $customerId) 0

# Draft lifecycle is writable only inside the authenticated Sale scope.
$draftId = "$runId-DRAFT"
$draftBody = @{
  id = $draftId; customer_id = $customerId; customer_name = "$runId Customer"
  company_id = 'ABS_NORTH'; notes = $runId; items = @(@{ variantId = $chosenProduct.id; quantity = 1 })
  total_market = 0; total_discount = 0; subtotal = 0; discount_value = 0
  discount_type = 'amount'; discount_amount = 0; other_fee_value = 0
  other_fee_type = 'amount'; other_fee_amount = 0; total_payable = 0
  status = 'draft'; created_by = $sale.userId; pricelist_id = $chosenList.id
}
$draftCreate = Invoke-JsonApi -Method POST -Path 'draft_orders' -Token $sale.token -Body $draftBody
Add-Result 'sale_creates_draft' (@($draftCreate.data).Count -eq 1) "draft_id=$draftId"
$draftDelete = Invoke-JsonApi -Method DELETE -Path "draft_orders?id=eq.$draftId" -Token $sale.token
$draftRows = Read-Rows $sale "draft_orders?select=id&id=eq.$draftId"
Add-Result 'sale_deletes_own_draft' ($draftRows.Count -eq 0) 'Draft removed without touching finalized history.'

$orderKey = [guid]::NewGuid().ToString()
$orderRequest = @{
  idempotencyKey = $orderKey
  customerId = $customerId
  customerName = 'FORGED NAME MUST BE IGNORED'
  notes = $runId
  pricelistId = $chosenList.id
  discountType = 'amount'; discountValue = 5000
  otherFeeType = 'amount'; otherFeeValue = 2000
  shippingFeeValue = 3000
  totalMarket = 1; totalPayable = 1; paidAmount = 0
  items = @(@{
    variantId = $chosenProduct.id; productId = $chosenProduct.id; quantity = 2
    discountType = 'percent'; discountValue = 10
    unitPrice = 1; finalUnitPrice = 1; priceListId = $chosenList.id; notes = $runId
  })
}

$forgedOrder = $orderRequest.Clone(); $forgedOrder.idempotencyKey = [guid]::NewGuid().ToString(); $forgedOrder.pricelistId = $privateList.id
$forgedOrder.items = @(@{ variantId = $chosenProduct.id; quantity = 1; priceListId = $privateList.id })
$privateDenied = Rpc $sale 'rpc_confirm_order' @{ p_order = $forgedOrder } -AllowError
Add-Result 'sale_cannot_force_private_pricelist' (-not $privateDenied.ok) "http_status=$($privateDenied.status)"

$saleFinancialDenied = Rpc $sale 'rpc_create_cashbook_transaction' @{ p_input = @{
  type = 'thu'; value = 999; method = 'cash'; category = $runId; partner = $runId
  accounting = $true; note = $runId; idempotencyKey = "$runId-sale-denied"
} } -AllowError
Add-Result 'sale_cannot_create_cashbook_entry' (-not $saleFinancialDenied.ok) "http_status=$($saleFinancialDenied.status)"

$orderCreated = Rpc $sale 'rpc_confirm_order' @{ p_order = $orderRequest }
$order = $orderCreated.data.order
$orderId = $order.id
$expectedSubtotal = [math]::Round(([decimal]$chosenItem.price * 2) * 0.9)
$expectedTotal = $expectedSubtotal - 5000 + 2000 + 3000
Assert-Decimal 'backend_ignores_browser_price' $order.totalMarket ([decimal]$chosenItem.price * 2)
Assert-Decimal 'backend_calculates_subtotal' $order.subtotal $expectedSubtotal
Assert-Decimal 'backend_calculates_total' $order.totalAmount $expectedTotal
Assert-Decimal 'order_creates_customer_debt' (Customer-Debt $accounting $customerId) $expectedTotal
Add-Result 'order_actor_is_auth_uid' ($orderCreated.data.performed_by -eq $sale.userId) "performed_by=$($orderCreated.data.performed_by)"

$orderRetry = Rpc $sale 'rpc_confirm_order' @{ p_order = $orderRequest }
Add-Result 'order_idempotency' ($orderRetry.data.already_finalized -eq $true -and $orderRetry.data.order.id -eq $orderId) "order_id=$orderId"

$paymentKey = "$runId-customer-payment"
$payment = Rpc $accounting 'rpc_record_customer_payment' @{
  p_customer_id = $customerId; p_amount = 100000; p_notes = $runId
  p_payment_method = 'bank'; p_idempotency_key = $paymentKey
}
$paymentCashbookId = $payment.data.cashbook_id
Assert-Decimal 'customer_payment_reduces_debt' (Customer-Debt $accounting $customerId) ($expectedTotal - 100000)
Add-Result 'payment_actor_is_auth_uid' ($payment.data.performed_by -eq $accounting.userId) "performed_by=$($payment.data.performed_by)"
$paymentRetry = Rpc $accounting 'rpc_record_customer_payment' @{
  p_customer_id = $customerId; p_amount = 100000; p_notes = $runId
  p_payment_method = 'bank'; p_idempotency_key = $paymentKey
}
Add-Result 'customer_payment_idempotency' ($paymentRetry.data.already_recorded -eq $true) "cashbook_id=$paymentCashbookId"

$orderItemId = @($order.items)[0].id
$returnKey = "$runId-return"
$return = Rpc $accounting 'rpc_record_sales_return' @{ p_input = @{
  orderId = $orderId; reason = "$runId partial return"; paymentMethod = 'bank'
  idempotencyKey = $returnKey; items = @(@{ saleItemId = $orderItemId; quantity = 1 })
} }
$returnId = $return.data.return_id
$debtAfterReturn = Customer-Debt $accounting $customerId
Assert-Decimal 'return_reduces_debt_by_canonical_amount' $debtAfterReturn (($expectedTotal - 100000) - [decimal]$return.data.debt_reduction)
Add-Result 'return_has_no_inventory_dependency' ([decimal]$return.data.total_refund -gt 0) "return_id=$returnId refund=$($return.data.total_refund)"
$returnRetry = Rpc $accounting 'rpc_record_sales_return' @{ p_input = @{
  orderId = $orderId; reason = "$runId partial return"; paymentMethod = 'bank'
  idempotencyKey = $returnKey; items = @(@{ saleItemId = $orderItemId; quantity = 1 })
} }
Add-Result 'return_idempotency' ($returnRetry.data.already_recorded -eq $true) "return_id=$returnId"

$cancelReturn = Rpc $accounting 'rpc_cancel_sales_return' @{ p_return_id = $returnId; p_reason = "$runId cancel return" }
Assert-Decimal 'cancel_return_restores_debt' (Customer-Debt $accounting $customerId) ($expectedTotal - 100000)
$cancelReturnRetry = Rpc $accounting 'rpc_cancel_sales_return' @{ p_return_id = $returnId; p_reason = "$runId cancel return retry" }
Add-Result 'cancel_return_idempotency' ($cancelReturnRetry.data.already_cancelled -eq $true) "return_id=$returnId"

$cancelPayment = Rpc $accounting 'rpc_cancel_cashbook_entry' @{ p_cashbook_id = $paymentCashbookId; p_reason = "$runId cancel receipt" }
Assert-Decimal 'cancel_payment_restores_debt' (Customer-Debt $accounting $customerId) $expectedTotal
$cancelPaymentRetry = Rpc $accounting 'rpc_cancel_cashbook_entry' @{ p_cashbook_id = $paymentCashbookId; p_reason = "$runId cancel receipt retry" }
Add-Result 'cancel_payment_idempotency' ($cancelPaymentRetry.data.already_cancelled -eq $true) "cashbook_id=$paymentCashbookId"

$cancelOrder = Rpc $accounting 'rpc_cancel_order' @{ p_order_id = $orderId; p_reason = "$runId cancel order" }
Assert-Decimal 'cancel_order_clears_debt' (Customer-Debt $accounting $customerId) 0
$cancelOrderRetry = Rpc $accounting 'rpc_cancel_order' @{ p_order_id = $orderId; p_reason = "$runId cancel order retry" }
Add-Result 'cancel_order_idempotency' ($cancelOrderRetry.data.already_cancelled -eq $true) "order_id=$orderId"

$cashbookKey = "$runId-manual-cashbook"
$manualCashbook = Rpc $accounting 'rpc_create_cashbook_transaction' @{ p_input = @{
  type = 'thu'; value = 12345; method = 'cash'; category = 'E2E other receipt'
  partner = $runId; accounting = $true; note = $runId
  transactionDate = $testTimestamp; idempotencyKey = $cashbookKey
} }
$manualCashbookId = $manualCashbook.data.cashbook_id
$cashbookRetry = Rpc $accounting 'rpc_create_cashbook_transaction' @{ p_input = @{
  type = 'thu'; value = 12345; method = 'cash'; category = 'E2E other receipt'
  partner = $runId; accounting = $true; note = $runId
  transactionDate = $manualCashbook.data.transaction.date; idempotencyKey = $cashbookKey
} }
Add-Result 'cashbook_idempotency' ($cashbookRetry.data.already_recorded -eq $true) "cashbook_id=$manualCashbookId"
$starred = Rpc $accounting 'rpc_set_cashbook_starred' @{ p_cashbook_id = $manualCashbookId; p_starred = $true }
Add-Result 'cashbook_star_toggle' ($starred.data.transaction.starred -eq $true) "cashbook_id=$manualCashbookId"
$cancelCashbook = Rpc $accounting 'rpc_cancel_cashbook_entry' @{ p_cashbook_id = $manualCashbookId; p_reason = "$runId cancel manual receipt" }
Add-Result 'cancel_manual_cashbook' ($cancelCashbook.data.transaction.status -eq 'cancelled') "cashbook_id=$manualCashbookId"

$supplier = Rpc $accounting 'rpc_save_supplier' @{ p_input = @{
  id = ($runId.ToLowerInvariant() + '-supplier'); code = $runId; name = "$runId Supplier"; phone = '0900000001'; address = 'Staging E2E only'
  openingDebt = 0; notes = $runId
} }
$supplierId = $supplier.data.supplier.id
Assert-Decimal 'supplier_starts_at_zero_debt' $supplier.data.supplier.debt 0

$purchaseKey = "$runId-purchase"
$purchase = Rpc $accounting 'rpc_create_purchase' @{ p_input = @{
  supplierId = $supplierId; invoiceNumber = "$runId-INV"; purchaseDate = $testTimestamp
  paidAmount = 20000; paymentMethod = 'bank'; notes = $runId; idempotencyKey = $purchaseKey
  items = @(@{ code = 'E2E-SERVICE'; name = 'E2E purchase item'; unit = 'item'; quantity = 2; unitPrice = 50000 })
} }
$purchaseId = $purchase.data.purchase.id
Assert-Decimal 'purchase_total_is_backend_calculated' $purchase.data.purchase.totalAmount 100000
Assert-Decimal 'purchase_initial_payment_updates_supplier_debt' $purchase.data.supplier.debt 80000
$purchaseRetry = Rpc $accounting 'rpc_create_purchase' @{ p_input = @{
  supplierId = $supplierId; invoiceNumber = "$runId-INV"; purchaseDate = $purchase.data.purchase.purchaseDate
  paidAmount = 20000; paymentMethod = 'bank'; notes = $runId; idempotencyKey = $purchaseKey
  items = @(@{ code = 'E2E-SERVICE'; name = 'E2E purchase item'; unit = 'item'; quantity = 2; unitPrice = 50000 })
} }
Add-Result 'purchase_idempotency' ($purchaseRetry.data.already_recorded -eq $true) "purchase_id=$purchaseId"

$supplierPaymentKey = "$runId-supplier-payment"
$supplierPayment = Rpc $accounting 'rpc_record_supplier_payment' @{ p_input = @{
  supplierId = $supplierId; purchaseId = $purchaseId; amount = 30000
  paymentMethod = 'cash'; notes = $runId; idempotencyKey = $supplierPaymentKey
} }
$supplierPaymentId = $supplierPayment.data.payment_id
Assert-Decimal 'supplier_payment_reduces_debt' $supplierPayment.data.supplier.debt 50000
$supplierPaymentRetry = Rpc $accounting 'rpc_record_supplier_payment' @{ p_input = @{
  supplierId = $supplierId; purchaseId = $purchaseId; amount = 30000
  paymentMethod = 'cash'; notes = $runId; idempotencyKey = $supplierPaymentKey
} }
Add-Result 'supplier_payment_idempotency' ($supplierPaymentRetry.data.already_recorded -eq $true) "payment_id=$supplierPaymentId"

$cancelSupplierPayment = Rpc $accounting 'rpc_cancel_supplier_payment' @{ p_payment_id = $supplierPaymentId; p_reason = "$runId cancel supplier payment" }
Assert-Decimal 'cancel_supplier_payment_restores_debt' $cancelSupplierPayment.data.supplier.debt 80000
$cancelSupplierPaymentRetry = Rpc $accounting 'rpc_cancel_supplier_payment' @{ p_payment_id = $supplierPaymentId; p_reason = "$runId cancel supplier payment retry" }
Add-Result 'cancel_supplier_payment_idempotency' ($cancelSupplierPaymentRetry.data.already_cancelled -eq $true) "payment_id=$supplierPaymentId"

$cancelPurchase = Rpc $accounting 'rpc_cancel_purchase' @{ p_purchase_id = $purchaseId; p_reason = "$runId cancel purchase" }
Assert-Decimal 'cancel_purchase_clears_supplier_debt' $cancelPurchase.data.supplier.debt 0
$cancelPurchaseRetry = Rpc $accounting 'rpc_cancel_purchase' @{ p_purchase_id = $purchaseId; p_reason = "$runId cancel purchase retry" }
Add-Result 'cancel_purchase_idempotency' ($cancelPurchaseRetry.data.already_cancelled -eq $true) "purchase_id=$purchaseId"

$auditRows = Read-Rows $admin "audit_logs?select=id,action,record_id,performed_by&or=(record_id.eq.$orderId,record_id.eq.$returnId,record_id.eq.$paymentCashbookId,record_id.eq.$purchaseId)&limit=100"
Add-Result 'financial_actions_are_audited' ($auditRows.Count -ge 4) "audit_rows=$($auditRows.Count)"
$wrongActorRows = @($auditRows | Where-Object { -not $_.performed_by })
Add-Result 'audit_actor_is_never_blank' ($wrongActorRows.Count -eq 0) "blank_actor_rows=$($wrongActorRows.Count)"

$summary = [pscustomobject]@{
  run_id = $runId
  passed = @($script:results | Where-Object passed).Count
  failed = @($script:results | Where-Object { -not $_.passed }).Count
  customer_id = $customerId
  order_id = $orderId
  return_id = $returnId
  supplier_id = $supplierId
  purchase_id = $purchaseId
  results = $script:results
}
$summary | ConvertTo-Json -Depth 8
