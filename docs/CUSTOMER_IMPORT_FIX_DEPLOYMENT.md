# Triển khai bản sửa nhập khách hàng đầu kỳ

Thực hiện theo đúng thứ tự để bản frontend không gọi RPC trước khi database sẵn
sàng. Không chạy lại các file SQL cũ ở thư mục gốc.

1. Sao lưu Supabase production hoặc tạo snapshot trước khi thay đổi.
2. Mở Supabase SQL Editor:
   - Nếu chưa từng chạy `0015`, chạy lần lượt
     `migrations/0015_customer_opening_financial_import.sql` rồi
     `migrations/0016_customer_import_rpc_variable_conflict_fix.sql`.
   - Nếu đã chạy `0015` và gặp lỗi `customer_id is ambiguous`, chỉ cần chạy
     `migrations/0016_customer_import_rpc_variable_conflict_fix.sql`.
3. Xác nhận migration đã được ghi nhận:

   ```sql
   select version, description
   from public.schema_migrations
   where version in ('0015', '0016')
   order by version;
   ```

4. Đẩy frontend mới lên GitHub Pages và tải lại trang bằng `Ctrl+F5`.
5. Đăng nhập bằng Admin hoặc Kế toán, nhập file ở chế độ **Gộp thêm**. Không dùng
   **Ghi đè toàn bộ** cho lần khôi phục này.
6. Kết quả đúng với `KH sau tool.xlsx`:
   - 1.583 khách hàng
   - Tổng doanh số: 176.429.196.802đ
   - Tổng trả hàng: 544.690.173đ
   - Doanh số sau trả: 175.884.506.629đ
   - Công nợ: 6.989.247.881đ
   - Ngày tạo và ngày giao dịch cuối phải khớp từng khách với file Excel.

RPC xử lý tối đa 250 khách mỗi giao dịch; frontend gửi 200 khách mỗi lần. Nếu
mạng ngắt giữa chừng, nhập lại cùng file ở chế độ **Gộp thêm** là an toàn: phần
số liệu đầu kỳ cũ được thay thế, không cộng trùng, còn đơn hàng/thanh toán phát
sinh sau đó được giữ nguyên.

## Tắt khẩn cấp mà không xóa dữ liệu

Nếu cần dừng chức năng nhập số liệu đầu kỳ, chạy:

```sql
revoke execute on function public.rpc_import_customer_financial_baselines(jsonb)
from authenticated;
```

Không xóa các cột baseline hoặc ledger đã ghi. Việc giữ chúng không ảnh hưởng
luồng đơn hàng, thu nợ và trả hàng hiện tại.
