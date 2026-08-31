# Sovie.vn SaaS staging readiness

Ngày kiểm định mã nguồn: 2026-08-29  
Supabase staging: `mqxqswwssmemkimnolfu`  
Production: không tác động

## Kết quả đã đạt

- Chuỗi migration trong mã nguồn và staging đã đồng bộ đến `0097` (42 migration từ `0056` đến `0097`). Migration quản lý `align_workspace_domains_to_sovie_vn` đã áp dụng ngày 2026-08-29; audit sau migration xác nhận cả 3 workspace dùng `*.sovie.vn`, không còn hostname `*.sovie.io.vn` và không có custom-domain xung đột hậu tố nội bộ.
- Console quản trị khách hàng cấp nền tảng đã tách khỏi quyền tenant; tài khoản
  `tvnhat10083@gmail.com` giữ riêng role `platform_owner`, không có tenant
  membership; `tranvnhat86@gmail.com` chỉ còn là Owner doanh nghiệp test.
- Luồng tạo khách hàng cấp nền tảng đã triển khai bằng RPC `0081` và Edge
  Function `platform-create-customer`; endpoint từ chối phiên không hợp lệ với
  HTTP 401, sự kiện provisioning không thể đọc trực tiếp từ browser.
- Console đã có luồng đổi gói, gia hạn trial, tạm khóa, kích hoạt lại và chấm
  dứt có xác nhận; mọi thay đổi đi qua RPC `0082` và được audit kép.
- Bảng giá thương mại tháng/năm và quota có thể quản lý từ console qua RPC
  `0083`. Staging hiện có giá Starter 100.000/900.000, Pro
  150.000/1.300.000 và Business 500.000/5.000.000 đồng theo tháng/năm;
  Pro và Business vẫn `is_public=false` cho tới khi phê duyệt thương mại.
- Adapter MoMo, tax policy tách riêng VAT và hai Edge Function
  `momo-create-checkout`/`momo-ipn` đã triển khai trên staging. IPN không yêu
  cầu JWT nhưng tự xác minh HMAC. Cấu hình database hiện là MoMo, VAT 8% theo
  chế độ giá chưa gồm thuế, đã có thông tin đơn vị phát hành và
  `billing_enabled=true`; trạng thái secret/URL và giao dịch sandbox vẫn phải
  được nghiệm thu riêng trước khi coi là sẵn sàng thương mại.
- Gói chi nhánh/kho và quota: SQL 9/9.
- Backup tenant có inventory/manifest: SQL 5/5.
- Soft-archive organization: SQL 7/7.
- `organization_id NOT NULL`: 33 bảng nghiệp vụ, schema test 2/2.
- Release readiness audit: 6/6; không có dòng nghiệp vụ thiếu tenant, RPC
  service không callable từ browser, Pro/Business vẫn chưa public.
- Commercial launch database audit: 11/11; bao gồm migration 0056–0097,
  tenant boundary, mobile read-model, domain `sovie.vn`, billing database và
  quyền RPC service-only.
- Regression mã nguồn: 502/502 và static build thành công tại lần kiểm định
  2026-08-29.
- Hành trình khách hàng mới có cổng `npm run test:journey`: một mật khẩu cá nhân, tự nhận lời mời, tạo/chuyển workspace, khôi phục mật khẩu và checklist 5 bước trên dashboard.
- Giao diện dùng chung module identity `20260817-saas-platform-v6`.
- Supabase Security Advisor: 0 error; lần quét sau migration có 4 info cho bảng
  service-only đã khóa browser, 106 warning chung về hàm `SECURITY DEFINER`
  callable bởi signed-in users và 1 warning chưa bật leaked-password
  protection. Các RPC nhạy cảm đã được kiểm tra quyền riêng bằng SQL, nhưng
  danh sách function vẫn cần allowlist/review và Auth protection cần bật sau
  khi nâng Supabase Pro trước production.

`audit_logs` còn 1.012 dòng platform/legacy không có tenant. Đây là ngoại lệ
bootstrap có chủ đích, không thuộc 33 bảng dữ liệu nghiệp vụ và không được đưa
vào tenant export. `activity_logs` không có dòng null tenant.

## Cổng còn phải hoàn thành trước commercial launch

1. Phê duyệt chính thức bảng giá chưa gồm VAT trên staging; Pro và Business
   vẫn `is_public=false` nên chưa được công bố thương mại.
2. Xác nhận với kế toán phần mềm/dịch vụ thuộc diện chịu VAT hay không chịu VAT;
   nếu chịu VAT thì nhập đúng thuế suất và thông tin đơn vị xuất hóa đơn.
3. Cấu hình MoMo sandbox secrets, URL trả về HTTPS và IPN URL; chạy giao dịch
   sandbox thành công, thất bại và callback lặp trước khi bật billing.
4. Cấu hình bốn biến Cloudflare cho Custom Hostname/SSL và chạy thử với domain test.
5. Nâng Supabase khỏi Free để có scheduled backups (và PITR nếu yêu cầu), tạo
   full dump rồi diễn tập restore vào một project staging mới, rỗng.
6. Review/allowlist toàn bộ Security Advisor warnings và chạy lại linter.
7. Kiểm thử nghiệm thu bằng tài khoản Owner/Admin/Accounting/Sale trên bản host
   staging trước khi lập kế hoạch migration production riêng.
8. Cấu hình custom SMTP và Redirect URLs cho `https://sovie.vn` cùng các hostname
   staging trước khi nghiệm thu email mời và khôi phục mật khẩu. Không dùng giới
   hạn gửi thử mặc định của Supabase cho production.

Không cổng nào ở trên được tự động vượt qua bằng secret giả, giá giả hoặc thao
tác trực tiếp lên production.
