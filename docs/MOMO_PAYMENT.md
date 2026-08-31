# Tích hợp thanh toán MoMo cho SoVie

SoVie dùng luồng MoMo Wallet one-time payment `captureWallet`. Giá gói trong
`saas_plans` là giá trước thuế; subtotal, thuế và tổng thanh toán được tính tại
database, không lấy từ trình duyệt.

Tài liệu chính thức:

- https://developers.momo.vn/v3/vi/docs/payment/api/wallet/onetime/
- https://developers.momo.vn/v3/vi/docs/payment/api/result-handling/notification/
- https://developers.momo.vn/v3/vi/docs/payment/api/other/signature/

## Supabase Edge Function secrets

Hai Function `momo-create-checkout` và `momo-ipn` cần các secrets:

- `MOMO_PARTNER_CODE`
- `MOMO_ACCESS_KEY`
- `MOMO_SECRET_KEY`
- `MOMO_API_BASE` — staging: `https://test-payment.momo.vn`
- `MOMO_REDIRECT_URL` — URL HTTPS trở về trang thanh toán SoVie
- `MOMO_IPN_URL` — `https://mqxqswwssmemkimnolfu.supabase.co/functions/v1/momo-ipn`

`momo-ipn` phải tắt Verify JWT vì MoMo gọi server-to-server. Function tự kiểm
tra HMAC-SHA256, partnerCode, orderId và amount trước khi cập nhật subscription.
IPN hợp lệ trả HTTP 204.

## Cổng mở thanh toán

Thanh toán mặc định tắt. Chỉ bật khi:

1. Giá tháng và năm của mọi gói công khai lớn hơn 0.
2. Kế toán xác nhận SoVie là dịch vụ không chịu VAT hoặc nhập thuế suất áp dụng.
3. Tên đơn vị phát hành hóa đơn và mã số thuế hợp lệ.
4. Secrets MoMo test đã được cấu hình và giao dịch sandbox thành công.

Không đưa access key hoặc secret key vào JavaScript trình duyệt, SQL migration,
ảnh chụp hoặc tài liệu bàn giao.
