# Hợp đồng webhook thanh toán SoVie (legacy/generic)

Luồng checkout mới đã chọn MoMo và được mô tả tại `docs/MOMO_PAYMENT.md`.
Endpoint dưới đây được giữ cho tương thích với adapter provider-neutral cũ;
không dùng endpoint này làm IPN MoMo.

Endpoint staging:

`POST https://mqxqswwssmemkimnolfu.supabase.co/functions/v1/billing-webhook`

## Chữ ký

- Secret nằm trong Supabase Edge Function secret `BILLING_WEBHOOK_SECRET`; không
  đưa vào trình duyệt hoặc repository.
- Header `x-sovie-timestamp` là Unix time 10 chữ số.
- Chuỗi ký là `<timestamp>.<raw request body>`.
- Header `x-sovie-signature` có dạng `v1=<hex HMAC-SHA256>`.
- Function từ chối timestamp lệch quá 300 giây và so sánh chữ ký constant-time.

## Payload chuẩn hóa

```json
{
  "eventId": "provider-event-id",
  "occurredAt": "2026-08-17T03:30:00Z",
  "organizationId": "workspace-uuid",
  "provider": "payos",
  "type": "invoice_paid",
  "planId": "business",
  "checkoutRequestId": "optional-request-uuid",
  "invoice": {
    "id": "provider-invoice-id",
    "number": "INV-001",
    "total": 299000,
    "currency": "VND",
    "url": "https://provider.example/invoices/INV-001"
  },
  "period": {
    "start": "2026-08-17T00:00:00Z",
    "end": "2026-09-17T00:00:00Z"
  }
}
```

Các loại sự kiện: `checkout_completed`, `invoice_open`, `invoice_paid`,
`invoice_failed`, `invoice_void`.

## Trạng thái triển khai

- Migration `0072` và Edge Function đã triển khai trên Supabase staging.
- `Verify JWT with legacy secret` đã tắt; HMAC là ranh giới xác thực duy nhất.
- Function cố ý trả `503` khi chưa cấu hình secret.
- Cổng thanh toán mới là MoMo; cấu hình mới dùng các secret `MOMO_*` và endpoint
  `momo-ipn`, không dùng `BILLING_WEBHOOK_SECRET`.
- Production chưa được tác động.
