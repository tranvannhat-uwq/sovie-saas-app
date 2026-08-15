# Ánh xạ nhập Excel khách hàng

Luồng nhập chỉ đọc sheet `DanhSachKhachHang`. Tiêu đề được bỏ BOM, chuẩn hóa
Unicode, khoảng trắng, chữ hoa/thường và dấu tiếng Việt trước khi ánh xạ.

| Cột Excel | Field ứng dụng | Đích lưu | Cách xử lý |
|---|---|---|---|
| Mã khách hàng | `code` | `customers.code` | Trực tiếp; dùng để gộp khách hiện có |
| Tên khách hàng | `name` | `customers.name` | Trực tiếp, bắt buộc |
| Điện thoại | `phone` | `customers.phone` | Chuỗi, giữ số 0 đầu |
| Địa chỉ | `address` | `customers.address` | Trực tiếp |
| Nhãn sơn | `assignedBrand`, `assignedBrandId` | `customers.assigned_brand`, `assigned_brand_id` | Tra cứu tên/id đã chuẩn hóa; không khớp thì cảnh báo và để trống |
| Bảng giá | `pricelistId` | `customers.pricelist_id`, `default_price_list_id` | Tra cứu tên/id đã chuẩn hóa; không khớp thì cảnh báo và để trống |
| Người quản lý | `managedBy` | `customers.managed_by` | Khớp username/tên/alias duy nhất; không khớp thì cảnh báo và để trống |
| Tổng doanh số | `totalTransaction` | `customers.total_transaction` | RPC số dư đầu kỳ |
| Tổng giá trị trả hàng | `totalReturn` | `customers.total_return` | RPC số dư đầu kỳ |
| Doanh số sau trả | `netRevenue` | `customers.net_revenue` | RPC số dư đầu kỳ; giữ cả giá trị 0 |
| Công nợ hiện tại | `debt` | `customers.debt` và ledger công nợ | RPC số dư đầu kỳ; giữ số âm |
| Ngày giao dịch cuối | `lastOrderAt` | `customers.last_order_at` | Parse ngày tập trung, không dùng lẫn Ngày tạo |
| Ngày tạo | `createdAt` | `customers.created_at` | Parse ngày tập trung, không thay bằng ngày nhập |
| Số ngày nợ | `debtDays` | `customers.brand_discounts.debtDays` | Số nguyên, giữ số âm và 0 |
| Ghi chú | `notes` | `customers.notes` | Trực tiếp |

Các trường tài chính và ngày được ghi qua
`rpc_import_customer_financial_baselines`; ghi lại cùng file sẽ thay phần số dư
đầu kỳ đã nhập trước đó, không cộng trùng và không xóa nghiệp vụ phát sinh sau
lần nhập. Ô trống của khách hiện có giữ nguyên giá trị trước đó.

## Nguyên nhân lỗi ngày

Payload profile cũ cố ý không gửi `created_at` và các trường tài chính. Sau đó
luồng nhập lại gán `new Date().toISOString()` khi `createdAt` bị thiếu, nên
PostgreSQL cũng có thể dùng `created_at DEFAULT now()` trước khi ngày Excel được
ghi. Vì vậy ngày nhập 03/08/2026 xuất hiện thay cho ngày ở cột M.

Bản sửa chuyển `Ngày tạo` qua RPC được kiểm soát, xóa fallback ngày hiện tại,
và đọc lại các baseline từ Supabase để so sánh ngày lẫn tổng tiền sau khi lưu.
