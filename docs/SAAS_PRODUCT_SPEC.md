# Đặc tả sản phẩm SaaS Sovie.vn — Giai đoạn 1

Phiên bản: 0.3  
Trạng thái: Nền tảng tenant, capability, catalog và quản trị địa điểm theo quota đã triển khai trên staging qua migration `0056`–`0075`.

## 1. Mô hình tenant

- Một khách hàng SaaS là một `organization`.
- Một tài khoản Auth có thể thuộc nhiều organization thông qua `organization_memberships`.
- Một organization có nhiều thành viên, chi nhánh, công ty/nhãn hàng và tên miền.
- Dữ liệu nghiệp vụ phải thuộc đúng một organization; không có dữ liệu dùng chung giữa tenant trừ danh mục hệ thống được công bố rõ ràng.
- Tenant hiện hành được xác định từ membership hợp lệ và workspace được chọn. Hostname chỉ hỗ trợ chọn workspace, không thay thế kiểm tra RLS.

## 2. Vai trò và quyền

| Năng lực | Owner | Admin | Accounting | Sale |
|---|---:|---:|---:|---:|
| Xem dashboard organization | Có | Có | Có | Giới hạn |
| Quản lý khách hàng | Có | Có | Có | Khách được giao |
| Tạo đơn hàng | Có | Có | Có | Có |
| Xác nhận giá thủ công | Có | Có | Có | Không |
| Thu/chi, công nợ, hoàn hàng | Có | Có | Có | Không |
| Quản lý sản phẩm và bảng giá | Có | Có | Có | Không |
| Quản lý thành viên | Có | Có | Không | Không |
| Thay đổi role Owner | Có | Không | Không | Không |
| Domain và nhận diện thương hiệu | Có | Có | Không | Không |
| Subscription và thanh toán SaaS | Có | Không | Không | Không |
| Xóa organization | Có | Không | Không | Không |

Ràng buộc:

- Không được xóa hoặc hạ quyền Owner cuối cùng.
- Admin không được tự nâng thành Owner.
- Accounting không được quản lý membership hoặc subscription.
- Sale chỉ đọc khách hàng, đơn hàng và bảng giá nằm trong phạm vi được giao.
- Service role không bao giờ xuất hiện trong trình duyệt.

## 3. Gói dịch vụ và quota baseline

Giá bán chưa được chốt ở Giai đoạn 1. Quota được dùng để xây enforcement và có thể điều chỉnh trước commercial launch.

| Gói | Người dùng | Chi nhánh | Kho | Đơn/tháng | Domain | Đối tượng |
|---|---:|---:|---:|---:|---|---|
| Starter | 5 | 1 | 1 | 500 | `tenant.sovie.vn` | Cửa hàng nhỏ |
| Pro | 20 | 5 | 5 | 5.000 | `tenant.sovie.vn` | Doanh nghiệp vừa |
| Business | 100 | 20 | 20 | 25.000 | 1 custom domain | Chuỗi và doanh nghiệp lớn |

Quy tắc quota:

- Quota được kiểm tra trong RPC/database, không chỉ trên giao diện.
- Bản ghi tài chính đã xác nhận không bị xóa hoặc sửa vì downgrade.
- Vượt quota đơn hàng chặn tạo giao dịch mới nhưng vẫn cho đọc, export và thanh toán subscription.
- Vượt quota người dùng chặn lời mời/kích hoạt mới; thành viên hiện có không bị xóa tự động.
- Trial kéo dài 14 ngày và dùng quota Starter.
- Owner/Admin tạo và cập nhật chi nhánh, kho qua RPC tenant-derived; không ghi trực tiếp bảng.
- Chi nhánh/kho mặc định phải hoạt động, và kho chỉ được gắn với chi nhánh hoạt động cùng organization.

## 4. Vòng đời subscription

| Trạng thái | Quyền truy cập |
|---|---|
| `trialing` | Đầy đủ theo Starter trong 14 ngày |
| `active` | Đầy đủ theo plan hiện hành |
| `past_due` | Grace period 7 ngày, vẫn ghi dữ liệu và hiển thị cảnh báo cho Owner |
| `suspended` | Chỉ đọc và export; Owner được mở trang thanh toán |
| `cancelled` | Chỉ đọc/export 30 ngày, sau đó Owner có thể yêu cầu soft-archive có backup và xác nhận slug |

Subscription status chỉ được cập nhật bởi webhook có chữ ký hoặc thao tác back-office được audit.
Thực thi archive chỉ dành cho service/back-office: khóa membership và domain,
giữ nguyên toàn bộ dữ liệu nghiệp vụ. Xóa vật lý là quy trình riêng chưa được tự động hóa.

## 5. Domain

- Mỗi organization luôn có một subdomain duy nhất trên `*.sovie.vn`.
- Slug dài 3–64 ký tự, chữ thường, số và dấu gạch ngang; không cho phép slug hệ thống.
- Starter và Pro dùng subdomain Sovie.
- Business được gắn một custom domain.
- Custom domain chỉ active khi hostname ownership và SSL đều verified.
- Một hostname chỉ thuộc một organization.
- Domain bị gỡ không làm mất organization hoặc dữ liệu.

## 6. Onboarding

1. Người dùng tạo tài khoản Auth và xác minh email.
2. Hệ thống tạo profile không đặc quyền.
3. Người dùng nhập tên doanh nghiệp và chọn subdomain.
4. RPC tạo organization, Owner membership và trial subscription trong một transaction.
5. Hệ thống khởi tạo branding, company và cấu hình mặc định của tenant.
6. Ứng dụng tải `rpc_my_saas_context()` và chuyển vào workspace mới.
7. Owner có thể mời thành viên sau khi onboarding hoàn tất.

Nếu bất kỳ bước database nào lỗi, organization không được tạo dở dang.

## 7. Dữ liệu và cách ly

- 33 bảng nghiệp vụ hiện hành và mọi bảng nghiệp vụ mới phải có `organization_id NOT NULL`; hai bảng platform audit là ngoại lệ bootstrap được kiểm soát.
- Mọi unique key nghiệp vụ phải bao gồm `organization_id`.
- Foreign key tenant phải ngăn liên kết chéo organization.
- RPC lấy organization từ authenticated context; payload trình duyệt không có thẩm quyền chọn tenant.
- Realtime, cache, export, backup và audit đều được phân vùng theo organization.
- Super-admin vận hành nền tảng dùng giao diện/back-office riêng, không dùng role tenant.

## 8. Tiêu chí nghiệm thu Giai đoạn 1

- Mô hình organization, role, plan, quota, subscription status và domain được mô tả không mâu thuẫn.
- Mọi năng lực nhạy cảm có đúng một nguồn thẩm quyền tại server/database.
- Luồng onboarding có transaction boundary rõ ràng.
- Có quy tắc cho trial, quá hạn, khóa và hủy.
- Có ma trận test dùng được làm đầu vào cho migration `0057` và UI.

## 9. Quyết định tạm hoãn

- Giá bán chính thức và cổng thanh toán Việt Nam.
- Thuế/hóa đơn cho phí subscription Sovie.
- Nhiều custom domain trên một organization.
- SSO doanh nghiệp.
- Project/database riêng cho tenant có yêu cầu tuân thủ đặc biệt.
