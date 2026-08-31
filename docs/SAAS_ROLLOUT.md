# Lộ trình chuyển Weblendon Billing sang SaaS

## Nguyên tắc

- Chỉ triển khai trên Supabase staging cho đến khi kiểm thử tenant isolation đạt yêu cầu.
- Mỗi bước là migration additive, có thể xác minh độc lập và không xóa dữ liệu nghiệp vụ.
- `organization_id` phải được kiểm tra ở database/RLS/RPC; lọc trên giao diện không phải ranh giới bảo mật.

## Các gói cải tiến trước rollout

1. **Tenant session context — hoàn tất:** đăng nhập và khôi phục phiên bắt buộc
   tải `rpc_my_saas_context()`, role lấy từ membership của organization hiện
   hành, cache bảng giá được phân vùng theo organization + tài khoản + role.
2. **Tenant-safe browser storage — hoàn tất:** toàn bộ cache nghiệp vụ được
   phân vùng theo organization; cache legacy không rõ chủ sở hữu bị loại bỏ,
   dữ liệu trong bộ nhớ được xóa khi kết thúc phiên tenant.
3. **Tenant database boundary — hoàn tất trên staging:** migration `0058` đã thay
   unique/FK hiện hữu sang phạm vi organization và thêm restrictive tenant
   policy cho toàn bộ 35 bảng nghiệp vụ. Migration `0059` giữ luồng bootstrap
   Auth hoạt động mà không mở ngoại lệ cho phiên người dùng. Migration `0060`
   chuyển 39/39 RPC nghiệp vụ sang executor `NOLOGIN/NOBYPASSRLS`; các ma trận
   bảng và RPC hai tenant đều đạt.
4. **Business capability model — hoàn tất nền tảng:** migration `0061` thêm
   settings, module, branch, warehouse, domain, quota context và tự khởi tạo cho
   cả organization cũ lẫn mới.
5. **Generic catalog — hoàn tất nền tảng:** migration `0062` thêm đơn vị tính,
   category, thuộc tính động, product/variant values và extension theo ngành.
   Quy tắc màu sơn chỉ còn bật cho workspace legacy; tenant mới là generic.
6. **Workspace onboarding — hoàn tất phần tạo/chuyển:** migration `0063` cho
   phép hồ sơ Auth chưa có membership tạo workspace đầu tiên, kiểm tra subdomain
   dành riêng/trùng lặp, khởi tạo trial Starter 14 ngày và chọn workspace mặc
   định. Giao diện đăng nhập mở onboarding bắt buộc cho tài khoản mới; menu cài
   đặt cho phép tạo thêm và chuyển workspace với lần tải dữ liệu tenant mới.
7. **Workspace members — hoàn tất nền tảng:** migration `0064` thay danh bạ
   profile toàn cục bằng danh sách membership của tenant hiện hành; Owner/Admin
   có thể thêm, đổi vai trò, khóa/mở thành viên và quota Starter 5 người được
   khóa/kiểm tra trong database. Edge Function `admin-create-user` đã triển khai
   trên staging và tự hoàn tác Auth user nếu không gắn được membership.
8. **Tenant-safe activity audit — hoàn tất:** migration `0065` sửa ba trigger
   audit legacy dùng conflict key cũ, đảm bảo cập nhật profile/draft/giá tiếp tục
   ghi log theo khóa có `organization_id`.
9. **Lời mời thành viên và chuyển Owner — hoàn tất trên staging:** migration
   `0066` thêm trạng thái lời mời, tự chấp nhận lời mời khi người dùng đăng nhập
   và chuyển quyền Owner trong một transaction với ràng buộc duy nhất một Owner
   hoạt động cho mỗi workspace. Edge Function `workspace-invite-member` gửi email
   cho tài khoản mới; tài khoản Auth đã tồn tại được gắn trực tiếp mà không gửi
   lại email. Ma trận tích hợp đạt 5/5 và rollback toàn bộ fixture.
10. **Danh bạ nhân sự không đăng nhập — hoàn tất trên staging:** migration `0067`
    tách nhân sự nghiệp vụ khỏi Supabase Auth/membership. Nhân viên, cộng tác
    viên và đối tác ngoài không chiếm quota tài khoản nhưng vẫn có thể được giao
    khách hàng hoặc chọn làm người phụ trách trong nghiệp vụ. Ma trận tenant và
    quyền đạt 5/5; toàn bộ test mã nguồn sau gói đạt 422/422.
11. **Vòng đời quyền truy cập subscription — hoàn tất trên staging:** migration `0068`
    cưỡng chế quyền ghi ở RLS/database: trial/active được ghi, past-due có grace
    period bảy ngày, paused/cancelled chỉ đọc. Sự kiện trạng thái chỉ dành cho
    service role, có audit và idempotency để chuẩn bị webhook thanh toán. Ma trận
    staging đạt 7/7 và toàn bộ regression test đạt 426/426.
12. **Quota đơn hàng theo tháng — hoàn tất trên staging:** migration `0069` kiểm tra
    giới hạn plan bằng trigger trước khi ghi đơn, khóa organization để chống hai
    giao dịch đồng thời vượt slot cuối và hiển thị mức dùng thực tế trong menu
    workspace. Ma trận tenant/quota đạt 5/5 và toàn bộ regression test đạt
    429/429.
13. **Custom domain — hoàn tất trên staging:** migration `0070` cho Owner
    đăng ký hostname theo quota plan, giữ bí mật TXT trong tenant và chỉ kích hoạt
    tên miền khi dịch vụ xác minh đã có cả DNS lẫn SSL. Khi vô hiệu hóa tên miền
    chính, hệ thống tự phục hồi subdomain `sovie.vn`. Ma trận quyền, quota, tenant
    isolation và chuyển domain chính đạt 7/7.
14. **Billing control plane — hoàn tất trên staging:** migration `0071` thêm yêu
    cầu đổi gói, hóa đơn tenant-scoped và sự kiện thanh toán service-only,
    idempotent. Owner có màn hình xem gói/hóa đơn; ma trận quyền, tenant và vòng
    đời thanh toán đạt 8/8.
15. **Webhook billing có chữ ký — hoàn tất nền tảng trên staging:** migration
    `0072` thêm thời điểm sự kiện, chặn webhook cũ ghi đè trạng thái mới và thu
    hồi RPC service không ký. Edge Function `billing-webhook` xác minh HMAC
    SHA-256, cửa sổ chống replay 5 phút và hiện fail-closed `503` cho đến khi cấu
    hình `BILLING_WEBHOOK_SECRET`. Ma trận thứ tự sự kiện đạt 7/7.
16. **Tự xác minh DNS — hoàn tất trên staging:** migration `0073` và Edge
    Function `verify-custom-domain` cho Owner kiểm tra TXT qua DNS-over-HTTPS,
    giới hạn một lần/phút, lưu audit tenant và không tự nhận SSL. JWT vẫn bắt
    buộc; request không đăng nhập nhận `401`. Ma trận staging đạt 7/7.
17. **Cloudflare SSL provisioning — hoàn tất nền tảng trên staging:** migration
    `0074` và Edge Function `provision-custom-domain` triển khai chu kỳ
    create/sync Custom Hostname. Domain chỉ active khi cả hostname và SSL phía
    Cloudflare đều active. Function giữ JWT và fail-closed cho đến khi cấu hình
    bốn secret/metadata Cloudflare; ma trận staging đạt 7/7.
18. **Chi nhánh, kho và quota plan — hoàn tất trên staging:** migration `0075`
    công bố quota Starter/Pro/Business và thêm RPC Owner/Admin quản lý chi nhánh,
    kho. Hạn mức được khóa/kiểm tra trong database, liên kết kho–chi nhánh không
    thể vượt tenant và địa điểm mặc định không thể bị tắt trực tiếp; ma trận
    staging đạt 9/9.
19. **Backup tenant có thể kiểm chứng — hoàn tất nền tảng trên staging:**
    migrations `0076`–`0077` thêm kiểm kê Owner/Admin theo tenant. File Excel
    `saas-tenant-v1` gắn organization ID/slug, migration hiện hành và manifest;
    export dừng nếu số dòng thay đổi giữa lúc đọc, dry-run từ chối file tenant
    khác hoặc manifest sai. Ma trận staging đạt 5/5. Supabase Free hiện không có
    scheduled project backup, nên full restore vẫn là cổng bắt buộc khi nâng Pro.
20. **Vòng đời lưu trữ organization — hoàn tất nền tảng trên staging:** migration
    `0078` chỉ cho Owner tạo yêu cầu sau khi hết 30 ngày chỉ đọc của subscription
    cancelled, bắt buộc nhập đúng slug và tham chiếu backup. Chỉ service/back-office
    thực thi idempotent; membership và domain bị khóa nhưng không có dòng nghiệp
    vụ nào bị xóa. Ma trận staging đạt 7/7.
21. **Tenant NOT NULL — hoàn tất trên staging:** migration `0079` kiểm tra không
    còn dòng thiếu tenant rồi đặt `organization_id NOT NULL` trên 33 bảng nghiệp
    vụ. Hai bảng platform audit giữ nullable theo ngoại lệ bootstrap đã kiểm
    soát; ma trận schema đạt 2/2.
22. **Tên miền chính `sovie.vn` — hoàn tất trên staging:** migration `0097`
    đối chiếu trạng thái thực tế với lịch sử migration cũ, kiểm tra collision
    trước khi đổi và chuẩn hóa 3/3 workspace sang `*.sovie.vn`. Audit thương mại
    đạt 9/9: không còn `*.sovie.io.vn`, provisioning mới và trigger chặn hậu tố
    nội bộ đều dùng canonical domain. Bộ audit sau khi bổ sung kiểm tra billing
    và RPC service-only đạt 11/11.

## Giai đoạn 1 — Control plane (migration 0056)

- Tạo organizations, memberships, plans và subscriptions.
- Backfill tài khoản hiện tại vào workspace `legacy-weblendon`.
- Thêm RPC đọc SaaS context, tạo workspace và chọn workspace mặc định.
- Chưa thay đổi phạm vi tenant của dữ liệu hóa đơn hiện tại.

## Giai đoạn 2 — Tenant hóa dữ liệu nghiệp vụ

Trạng thái: **Phase 2 đã triển khai và kiểm thử trên staging**. Migration `0057`
hoàn tất tenant envelope, backfill, foreign
key/index và write guard; bộ kiểm định staging đạt 38/38. Migration `0058` và
`0059` hoàn tất unique/FK/RLS cấp bảng; ma trận staging hai tenant đạt 5/5.
Migration `0060` khóa 39/39 RPC callable bằng executor không có BYPASSRLS;
ma trận RPC hai tenant đạt 5/5 và vẫn đạt lại sau khi refactor danh mục.

1. Thêm `organization_id` nullable và index vào từng bảng nghiệp vụ.
2. Backfill toàn bộ dữ liệu hiện tại sang legacy workspace và kiểm tra số lượng trước/sau.
3. Sửa foreign key/unique key từ khóa toàn cục sang khóa ghép theo organization.
4. Sửa toàn bộ RPC để lấy tenant từ `current_organization_id()`, không tin tenant do trình duyệt gửi lên.
5. Thay RLS bằng policy tenant + role, chạy ma trận kiểm thử hai tenant.
6. `organization_id NOT NULL` đã được áp dụng sau khi kiểm định không còn hàng nghiệp vụ chưa được gán.

## Giai đoạn 3 — Onboarding và quản trị workspace

- Trạng thái: **onboarding, quản trị membership, lời mời email và chuyển Owner đã
  hoàn tất trên staging** bằng migrations `0063`–`0066`; ma trận member đạt 6/6,
  ma trận invitation/Owner đạt 5/5 và đều rollback fixture sau khi chạy.
- Edge Function gửi lời mời giữ service-role ở phía server; tài khoản hiện hữu
  được gắn workspace trực tiếp, tài khoản mới đặt mật khẩu qua liên kết email.
- Giới hạn số thành viên và quota theo plan tại database/RPC.
- Danh bạ đối tác/nhân sự không yêu cầu tài khoản đăng nhập đã hoàn tất bằng
  migration `0067` và không tiêu thụ quota membership.

## Giai đoạn 4 — Billing thương mại

- Nền tảng trạng thái subscription và chế độ chỉ đọc đã hoàn tất bằng migration
  `0068`, trước khi kết nối nhà cung cấp thanh toán thật.
- Quota số đơn hàng theo tháng của từng plan đã được cưỡng chế bằng migration
  `0069`, bao gồm chống vượt quota do xác nhận đồng thời.
- Quy trình đăng ký và xác minh custom domain dành riêng cho plan có quyền domain
  đã hoàn tất bằng migration `0070`.
- Tự động hóa DNS/SSL và webhook trạng thái có chữ ký đã có nền tảng fail-closed;
  bước vận hành còn lại là cấu hình secret/adapter thật sau khi chọn nhà cung cấp.
- Chọn nhà cung cấp thanh toán và cấu hình secret/adapter payload thật cho Edge
  Function `billing-webhook` đã triển khai.
- Webhook cập nhật `organization_subscriptions`; trình duyệt chỉ đọc trạng thái.
- Grace period, past-due/suspension và audit cho thay đổi subscription.

## Cổng kiểm thử bắt buộc trước production

- User tenant A không đọc/ghi được bất kỳ dữ liệu nào của tenant B, kể cả khi đoán đúng ID.
- RPC không chấp nhận giả mạo `organization_id`, role, giá, tổng tiền hoặc subscription status.
- Backup/restore staging và rollback migration được diễn tập.
- Không có URL/key production trong bản build staging.
