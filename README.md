# Weblendon SaaS

Phiên bản web độc lập dùng để thử nghiệm chuyển hệ thống Weblendon Billing sang mô hình SaaS.

## Chạy bản SaaS cục bộ

Mở terminal đúng tại thư mục `saas-app`, sau đó chạy:

```powershell
npm ci
npm run dev
```

Ứng dụng SaaS chạy tại `http://localhost:3000`. Dependency phát triển được ghim
trong `package-lock.json`; dùng Node 20.x hoặc Node 22 trở lên cho máy chủ phát triển. Lệnh
`npm run deploy` dùng Wrangler 4.127.1 và cần Node 22 trở lên.

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

- Chuỗi migration trong mã nguồn hiện có đến `0101`; trạng thái staging được ghi nhận gần nhất trong [docs/SAAS_STAGING_READINESS.md](docs/SAAS_STAGING_READINESS.md) chỉ xác nhận đến `0097`. Đối chiếu `public.schema_migrations` trên staging trước khi áp dụng `0098`–`0101`; repository không tự xác nhận các migration mới hơn đã được triển khai.
- Bản web SaaS được ghim vào Supabase staging clone `mqxqswwssmemkimnolfu`; cấu hình production không còn nằm trong `js/config.js`.
- Dữ liệu hiện tại được giữ trong workspace tương thích `legacy-weblendon`.
- 35 bảng nghiệp vụ và 39 RPC callable đã được cách ly tenant và kiểm thử trên staging; migrations `0063`–`0066` đã bật tạo/chuyển workspace, trial Starter, quota, quản trị membership, lời mời email và chuyển quyền Owner nguyên tử.

Xem [docs/SAAS_PRODUCT_SPEC.md](docs/SAAS_PRODUCT_SPEC.md) để kiểm tra baseline
sản phẩm Giai đoạn 1 và [docs/SAAS_ROLLOUT.md](docs/SAAS_ROLLOUT.md) để theo dõi
các giai đoạn tiếp theo. Trạng thái staging và các cổng còn lại trước commercial
launch nằm tại [docs/SAAS_STAGING_READINESS.md](docs/SAAS_STAGING_READINESS.md).

## Kiểm tra cấu trúc trước khi phát hành

```powershell
npm run verify:structure
npm run release:check
```

`verify:structure` kiểm tra các module JavaScript có thể nạp từ ứng dụng, tài
nguyên tĩnh được triển khai và chuỗi migration liên tục/tự ghi nhận version.
Migration đã từng được áp dụng là lịch sử bất biến: khi đổi database, tạo file
migration mới thay vì sửa, gộp hoặc xóa file cũ. Các SQL legacy ở thư mục gốc
được giữ lại để đối chiếu hệ thống cũ và không được chạy sau chuỗi migration
trong `migrations/`.
