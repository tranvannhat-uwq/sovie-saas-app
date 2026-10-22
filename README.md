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
- `sovie.vn` là địa chỉ đăng nhập và sử dụng duy nhất. Các subdomain workspace
  và custom domain cũ được chuyển hướng về `https://sovie.vn`; mã workspace chỉ
  dùng để nhận diện doanh nghiệp sau khi đăng nhập. Cloudflare Worker
  `sovie-saas-staging` phục vụ website theo cấu hình `wrangler.jsonc`.
- GitHub Actions trong `.github/workflows/deploy-worker.yml` chạy kiểm tra phát
  hành (`npm run release:check`) cho pull request vào `main`, rồi tự triển khai
  Worker sau mỗi lần push/merge thành công vào `main`. Push lên nhánh tính năng
  chưa cập nhật website; hãy merge thay đổi vào `main` sau khi kiểm tra.
- Trong GitHub, vào **Settings → Secrets and variables → Actions** và thêm
  `CLOUDFLARE_API_TOKEN` cùng `CLOUDFLARE_ACCOUNT_ID`. Tạo token Cloudflare theo
  quyền tùy chỉnh **Workers Scripts: Edit** trên account SoVie và
  **Workers Routes: Edit** chỉ trên zone `sovie.vn`; không đặt token trong mã
  nguồn. Màn hình tạo token hiện giới hạn quyền Scripts ở cấp account.
- Có thể triển khai thủ công khi cần bằng lệnh sau trong `saas-app` với tài khoản
  Cloudflare đã đăng nhập:

```powershell
npm run deploy
```

- Lệnh này build thư mục `dist` rồi đưa tài nguyên tĩnh lên Worker đang phục vụ
  tên miền. Sau đó kiểm tra trang đăng nhập và chuyển workspace tại `sovie.vn`.
- `product-billing-app` dùng repository `tranvannhat-uwq/phan-mem-hoa-don`
  và tên miền `chamsockhachhang.store`; không đổi custom domain hoặc `CNAME`
  của repository đó khi triển khai SaaS.

- Chuỗi migration trong mã nguồn hiện có đến `0108`. SQL Editor ghi nhận staging `mqxqswwssmemkimnolfu` đã áp dụng `0107`; cần áp dụng `0108_centralized_login_and_pause_custom_domains.sql` sau khi phát hành giao diện mới. Trong Supabase Auth, đặt Site URL là `https://sovie.vn` và Redirect URLs gồm `https://sovie.vn/**` (cộng địa chỉ localhost dùng khi phát triển).
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
