# Weblendon SaaS

Phiên bản web độc lập dùng để thử nghiệm chuyển hệ thống Weblendon Billing sang mô hình SaaS.

## Chạy bản SaaS cục bộ

Mở terminal đúng tại thư mục `saas-app`, sau đó chạy:

```powershell
npm run dev
```

Ứng dụng SaaS chạy tại `http://localhost:3000`. File `package.json` riêng trong
thư mục này bảo đảm lệnh trên không còn khởi động nhầm `product-billing-app`.

## Nguyên tắc an toàn

- Dự án này tách biệt hoàn toàn khỏi `product-billing-app` đang vận hành.
- Chỉ kết nối Supabase staging trong giai đoạn phát triển.
- Không chạy migration SaaS trên database production hiện tại.
- Mọi bảng nghiệp vụ và RPC mới phải được kiểm thử cách ly dữ liệu giữa các tenant.

## Trạng thái triển khai

Mã nguồn được sao chép từ hệ thống web hiện tại để giữ nguyên nghiệp vụ.

### Mã nguồn và nơi triển khai website

- Mã nguồn SaaS nằm trong repository `tranvannhat-uwq/sovie-saas-app`, nhánh `main`.
- `sovie.vn` và các tên miền workspace như `test.sovie.vn` được phục vụ bởi
  Cloudflare Worker `sovie-saas-staging`. Cấu hình được lưu trong `wrangler.jsonc`.
- GitHub Pages có quy trình triển khai riêng, nhưng push GitHub **chưa tự cập nhật
  Worker**. Sau khi push, chạy lệnh sau trong `saas-app` bằng tài khoản Cloudflare
  đã đăng nhập:

```powershell
npm run deploy
```

- Lệnh này build thư mục `dist` rồi đưa tài nguyên tĩnh lên Worker đang phục vụ
  tên miền. Sau đó kiểm tra nội dung thực tế tại `sovie.vn` và một tên miền workspace.
- `product-billing-app` dùng repository `tranvannhat-uwq/phan-mem-hoa-don`
  và tên miền `chamsockhachhang.store`; không đổi custom domain hoặc `CNAME`
  của repository đó khi triển khai SaaS.

- Chuỗi migration `0056`–`0096` đã bổ sung control plane, ranh giới tenant cấp bảng/RPC, capability, generic catalog, onboarding, quản trị thành viên, lời mời email, chuyển quyền Owner, danh bạ nhân sự, vòng đời subscription, quota đơn hàng tháng, custom domain, billing MoMo có IPN ký HMAC, tự xác minh DNS, hàng đợi cấp SSL Cloudflare, quản trị chi nhánh/kho theo quota, backup riêng từng tenant, soft-archive organization, `organization_id NOT NULL` cho 33 bảng nghiệp vụ, bảng điều khiển quản trị khách hàng, luồng khởi tạo tenant, quản lý vòng đời khách hàng, bảng giá thương mại tháng/năm, read model Admin mobile và tên miền chuẩn `sovie.vn`.
- Bản web SaaS được ghim vào Supabase staging clone `mqxqswwssmemkimnolfu`; cấu hình production không còn nằm trong `js/config.js`.
- Dữ liệu hiện tại được giữ trong workspace tương thích `legacy-weblendon`.
- 35 bảng nghiệp vụ và 39 RPC callable đã được cách ly tenant và kiểm thử trên staging; migrations `0063`–`0066` đã bật tạo/chuyển workspace, trial Starter, quota, quản trị membership, lời mời email và chuyển quyền Owner nguyên tử.

Xem [docs/SAAS_PRODUCT_SPEC.md](docs/SAAS_PRODUCT_SPEC.md) để kiểm tra baseline
sản phẩm Giai đoạn 1 và [docs/SAAS_ROLLOUT.md](docs/SAAS_ROLLOUT.md) để theo dõi
các giai đoạn tiếp theo. Trạng thái staging và các cổng còn lại trước commercial
launch nằm tại [docs/SAAS_STAGING_READINESS.md](docs/SAAS_STAGING_READINESS.md).
