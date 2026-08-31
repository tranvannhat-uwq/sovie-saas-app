# Cloudflare for SaaS cho custom domain

## Trạng thái

- Migration `0074` và Edge Function `provision-custom-domain` đã triển khai trên
  Supabase staging.
- Function yêu cầu JWT của Owner và không hoạt động khi thiếu cấu hình Cloudflare.
- Cloudflare for SaaS đã bật cho zone `sovie.vn` ngày 29/08/2026.
- Fallback origin `origin.sovie.vn` đã ở trạng thái `active`.
- Worker route `*/*` trỏ tới `sovie-saas-staging`; bundle đang chạy khớp SHA-256
  với `dist/index.html` tại thời điểm nghiệm thu.
- Bốn Edge Function secrets Cloudflare đã được lưu trên project staging
  `mqxqswwssmemkimnolfu` và xác nhận có digest trên Supabase.
- Nameserver đã được người quản trị tên miền thay đổi ngày 29/08/2026. Tại lần
  kiểm tra ngay sau thay đổi, Cloudflare, Google DNS và DNS hệ thống vẫn trả về
  cặp vCloudDNS cũ; Cloudflare zone tiếp tục ở trạng thái `pending` trong thời
  gian registry/resolver propagation. Đã bấm `Check nameservers now` trên
  Cloudflare Dashboard.
- Production chưa được tác động.

## Cấu hình staging hiện tại

- SaaS zone: `sovie.vn`
- Cloudflare zone ID: `769836978639c73986cb55a724f41065`
- Fallback origin: `origin.sovie.vn`
- Customer CNAME target: `customers.sovie.vn`
- Worker: `sovie-saas-staging`
- Worker route: `*/*`
- Cloudflare nameservers cần dùng:
  - `kellen.ns.cloudflare.com`
  - `lola.ns.cloudflare.com`
- Nameservers cũ cần thay thế:
  - `catba.vclouddns.com`
  - `haiphong.vclouddns.com`

## Cấu hình cần cung cấp

Tạo API token Cloudflare chỉ có quyền cần thiết cho SaaS zone, rồi thêm các Edge
Function secrets:

- `CLOUDFLARE_API_TOKEN`: token có quyền SSL and Certificates Write.
- `CLOUDFLARE_ZONE_ID`: zone ID của `sovie.vn` trên Cloudflare.
- `CLOUDFLARE_ORIGIN_HOSTNAME`: hostname origin/fallback đã cấu hình trong zone.
- `CLOUDFLARE_CNAME_TARGET`: CNAME target mà khách hàng phải trỏ domain tới.

Không lưu API token trong repository hoặc trình duyệt.

## Nghiệm thu sau khi đổi nameserver

1. `NS sovie.vn` chỉ trả về `kellen.ns.cloudflare.com` và
   `lola.ns.cloudflare.com`.
2. Cloudflare zone chuyển từ `pending` sang `active`.
3. `origin.sovie.vn` và `customers.sovie.vn` đi qua proxy Cloudflare.
4. Tạo một custom hostname thử nghiệm thuộc domain mà khách hàng kiểm soát.
5. Hoàn tất TXT ownership verification và CNAME về `customers.sovie.vn`.
6. Xác nhận Cloudflare trả cả hostname status và SSL status là `active`.
7. Xác nhận HTTPS trả đúng ứng dụng, chứng chỉ hợp lệ, điều hướng SPA hoạt động
   và database chỉ chuyển domain sang `active` sau khi cả hai trạng thái trên đạt.

## Luồng xử lý

1. Owner xác minh TXT SoVie bằng `verify-custom-domain`.
2. Owner bấm cấp SSL; function tạo Cloudflare Custom Hostname với HTTP DCV,
   TLS tối thiểu 1.2 và origin cố định.
3. Giao diện hiển thị CNAME target.
4. Các lần kiểm tra sau gọi API chi tiết hostname.
5. Chỉ khi `result.status = active` và `result.ssl.status = active`, database mới
   chuyển custom domain thành `active`.

API tham chiếu:

- https://developers.cloudflare.com/api/resources/custom_hostnames/methods/create/
- https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/start/common-api-calls/
