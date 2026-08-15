# Weblendon SaaS

Phiên bản web độc lập dùng để thử nghiệm chuyển hệ thống Weblendon Billing sang mô hình SaaS.

## Nguyên tắc an toàn

- Dự án này tách biệt hoàn toàn khỏi `product-billing-app` đang vận hành.
- Chỉ kết nối Supabase staging trong giai đoạn phát triển.
- Không chạy migration SaaS trên database production hiện tại.
- Mọi bảng nghiệp vụ và RPC mới phải được kiểm thử cách ly dữ liệu giữa các tenant.

## Trạng thái ban đầu

Mã nguồn được sao chép từ hệ thống web hiện tại để giữ nguyên nghiệp vụ. Bước tiếp theo là tách cấu hình môi trường, sau đó bổ sung `organizations`, membership và RLS theo tenant trước khi phát triển subscription/billing.
