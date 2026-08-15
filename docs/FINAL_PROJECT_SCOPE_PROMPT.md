# PROMPT TỔNG CUỐI CÙNG – HỆ THỐNG LÊN ĐƠN VÀ TÀI CHÍNH

Bạn là Senior Full-stack Engineer, Software Architect, Database Engineer, QA và Security Reviewer.

Hãy chuẩn hóa dự án website lên đơn theo tài liệu này. Đây là nguồn yêu cầu chính. Không tự thay đổi nghiệp vụ, không tự thêm chức năng ngoài phạm vi và không đoán khi dữ liệu chưa đủ rõ.

Không sửa toàn bộ hệ thống trong một lượt. Mỗi lượt chỉ thực hiện đúng một giai đoạn đã được yêu cầu, có báo cáo trước khi sửa và kiểm thử sau khi sửa.

Không triển khai production. Không chạy migration trên production. Không dùng dữ liệu production để thử nghiệm. Không tuyên bố hoàn thành nếu chưa chạy integration test trên database staging thật.

## I. Phạm vi cuối cùng

Dự án chỉ gồm các phân hệ:

1. Đăng nhập và phân quyền.
2. Tài khoản nhân viên.
3. Công ty và hãng sơn.
4. Sản phẩm cha và quy cách/SKU.
5. Bảng giá.
6. Khách hàng và đại lý.
7. Lập đơn hàng.
8. Đơn nháp.
9. Lịch sử đơn hàng.
10. In hóa đơn và phiếu.
11. Thanh toán.
12. Công nợ khách hàng.
13. Sổ quỹ.
14. Trả hàng bán.
15. Nhà cung cấp.
16. Phiếu mua hàng.
17. Công nợ nhà cung cấp.
18. Dashboard.
19. Báo cáo.
20. KPI.
21. Lương và hoa hồng.
22. Backup, restore và đồng bộ dữ liệu.
23. Audit log và bảo mật.

## II. Ngoài phạm vi

Dự án không xây dựng, sửa, mở rộng hoặc tái tạo:

- Quản lý kho hoặc vị trí kho.
- Quản lý tồn kho.
- Nguyên liệu, bán thành phẩm hoặc tồn thành phẩm.
- Công thức, định mức hoặc lệnh sản xuất.
- Xuất nguyên liệu, đóng gói hoặc nhật ký sản xuất.
- Tính nhu cầu hoặc kiểm tra thiếu nguyên liệu.
- Báo cáo sản xuất hoặc báo cáo nhập–xuất–tồn.

Nếu source hoặc database hiện tại đã có các module/bảng này:

- Không xóa dữ liệu cũ.
- Không sửa migration cũ đã có thể từng được áp dụng.
- Không tạo migration, RPC, test hoặc kế hoạch mới để mở rộng chúng.
- Tách chúng khỏi đơn hàng, công nợ, sổ quỹ, dashboard, báo cáo, KPI và lương.
- Ẩn menu hoặc đánh dấu “Chưa sử dụng”.
- Không gọi API/RPC liên quan từ frontend.
- Thiếu các bảng này không được làm lỗi đăng nhập, bootstrap, tải dữ liệu, lập đơn, chốt đơn, trả hàng hoặc báo cáo.

Sản phẩm cha và quy cách/SKU vẫn thuộc phạm vi. SKU chỉ là định danh mặt hàng bán, không đại diện cho tồn kho.

## III. Cách thực hiện bắt buộc

Trước khi sửa một giai đoạn:

1. Đọc các file frontend, domain, service và migration liên quan.
2. Đọc các SQL cũ để nhận diện xung đột nhưng không chạy lại chúng.
3. Lập bản đồ bảng, RPC, RLS, luồng frontend, dữ liệu Cloud và dữ liệu localStorage trong phạm vi giai đoạn.
4. Xác định logic đúng, logic thiếu, logic chỉ có ở frontend và nguy cơ sai dữ liệu.
5. Báo phạm vi, file dự kiến sửa, migration dự kiến tạo, công thức và rủi ro.

Chỉ thư mục `migrations` là nguồn migration chuẩn. SQL cũ ngoài thư mục này không được chạy lại.

Supabase/PostgreSQL là nguồn dữ liệu chính. Dữ liệu đơn hàng, thanh toán, công nợ, sổ quỹ, mua hàng, công nợ nhà cung cấp, KPI, lương và hoa hồng không được chỉ tồn tại trong localStorage.

Mọi nghiệp vụ nhiều bước phải chạy trong một transaction database. Một bước lỗi phải rollback toàn bộ.

## IV. Kiến trúc xác thực và phân quyền

Kiến trúc bắt buộc:

```text
Supabase Auth
→ auth.uid()
→ public.profiles.auth_user_id
→ role trong database
→ RLS/RPC
→ dữ liệu nghiệp vụ
```

Role chuẩn:

- `admin`
- `accounting`
- `sale`

Không dùng role cũ như `ketoan`, `kinhdoanh` hoặc `nhanvien`.

Không lấy quyền từ localStorage, sessionStorage, biến frontend, email, username hoặc role do client gửi. Frontend chỉ điều khiển hiển thị; RLS và RPC quyết định quyền thật.

Không dùng service-role key ở frontend. Không dùng bảng mật khẩu plaintext. Không fallback sang bảng `users` cũ.

Sau đăng nhập:

1. Lấy `session.user.id`.
2. Tìm đúng một profile theo `auth_user_id`.
3. Kiểm tra `is_active`.
4. Kiểm tra role hợp lệ.
5. Tải dữ liệu theo RLS.
6. Nếu profile không hợp lệ, sign out và xóa state phiên.

Auth user mới chỉ được tạo profile mặc định role `sale`. Không tự nâng quyền dựa trên email hoặc metadata client.

## V. Ma trận quyền

### Admin

- Quản lý profile và tài khoản.
- Quản lý công ty, hãng, sản phẩm, SKU, bảng giá và khách hàng.
- Quản lý đơn, thanh toán, công nợ, sổ quỹ và trả hàng.
- Quản lý nhà cung cấp, phiếu mua và công nợ nhà cung cấp.
- Quản lý KPI, lương, hoa hồng, backup/restore và cấu hình.
- Xem audit log.

### Accounting

- Quản lý khách hàng, bảng giá và đơn hàng theo nghiệp vụ.
- Xem và dùng bảng giá riêng đại lý.
- Quản lý thanh toán, công nợ khách hàng, sổ quỹ và trả hàng.
- Quản lý nhà cung cấp, phiếu mua, công nợ nhà cung cấp và phiếu chi.
- Quản lý KPI, lương và hoa hồng nếu được giao quyền.
- Không tự quản lý tài khoản hệ thống hoặc sửa/xóa audit log.

### Sale

- Chỉ xem khách hàng được giao.
- Chỉ tạo và xem đơn thuộc phạm vi của mình.
- Chỉ tạo, sửa và xóa đơn nháp của mình.
- Chỉ xem và sử dụng bảng giá được bật cho Sale.
- Không được đọc tên, mã, giá hoặc chi tiết bảng giá riêng đại lý.
- Không được thu nợ, sửa công nợ, truy cập sổ quỹ hoặc trả hàng.
- Không được sửa bảng giá, lương, hoa hồng, cấu hình hoặc audit log.
- Không được gửi trực tiếp ID bảng giá bí mật để tạo đơn.

Quyền phải đồng bộ giữa frontend, RLS, RPC, export, báo cáo và network response. Không chỉ ẩn nút.

## VI. Công ty và hãng sơn

- Thêm, sửa và ngừng sử dụng hãng.
- Liên kết hãng với công ty bằng ID.
- Quản lý logo, hotline, email và địa chỉ.
- Đổi tên hãng phải đồng bộ dữ liệu master liên quan nhưng không thay snapshot lịch sử.
- Xác định đúng công ty và nhãn ghi nhận doanh thu.
- Hỗ trợ hãng dùng chung và logic FESTIVAL nếu đã có nghiệp vụ rõ ràng.
- Không hard-code tên hãng/công ty ở nhiều file.

## VII. Sản phẩm cha và quy cách/SKU

Mô hình:

```text
CT-Đ1 – Sơn lót chống kiềm nội thất
├─ CT-Đ1-LON – Lon 6,3 kg
└─ CT-Đ1-THUNG – Thùng 22,5 kg
```

Mỗi SKU có mã riêng, loại bao bì, trọng lượng/thể tích, đơn vị, trạng thái hoạt động và barcode nếu hệ thống hỗ trợ.

Không xóa vật lý SKU đã phát sinh đơn; chỉ ngừng hoạt động. Đơn cũ giữ snapshot tên, SKU, quy cách và đơn vị.

Quy cách chỉ phục vụ:

- Chọn đúng mặt hàng khi lên đơn.
- Lấy giá đúng theo bảng giá.
- Lưu đúng SKU đã bán.
- Trả đúng mặt hàng.
- Báo cáo doanh số theo quy cách.

Quy cách không dùng để quản lý tồn kho.

Khi lên đơn, chọn sản phẩm cha rồi chọn SKU. Nếu chỉ có một SKU có thể tự chọn. Giá luôn theo SKU, không theo sản phẩm cha.

Tìm kiếm và import/export phải hỗ trợ mã gốc, SKU, tên, hãng, quy cách và trọng lượng/thể tích.

## VIII. Bảng giá

Các loại bảng giá:

- Giá chung.
- Bảng giá dành cho Sale.
- Bảng giá nhóm khách hàng.
- Bảng giá riêng đại lý.
- Bảng giá kế thừa.

Giá lưu theo SKU. Mỗi bảng giá có mã, tên, loại, thời hạn hiệu lực, thứ tự ưu tiên, trạng thái, cờ cho Sale dùng, bảng giá cha và đối tượng được gán.

Thứ tự chọn giá:

1. Bảng giá gán trực tiếp cho khách hàng.
2. Bảng giá riêng khách hàng.
3. Bảng giá nhóm khách hàng.
4. Bảng giá được chọn thủ công và người dùng có quyền dùng.
5. Giá chung.
6. Không có giá thì từ chối chốt đơn.

Sale không được tải bảng giá riêng về trình duyệt hoặc thấy qua localStorage, console, HTML ẩn hay export. Backend phải từ chối mọi ID bảng giá trái quyền.

Giá âm bị từ chối. Giá bằng 0 chỉ được chấp nhận theo quy tắc xác nhận rõ ràng.

## IX. Khách hàng và đại lý

Khách hàng gồm mã, tên, điện thoại chuẩn hóa, địa chỉ, tỉnh, nhãn đại lý, nhân viên quản lý, bảng giá mặc định, ghi chú, hỗ trợ vận chuyển và trạng thái.

Mã khách hàng phải unique ở database. Cơ chế chống trùng điện thoại không được chỉ nằm ở frontend.

Khách đã phát sinh nghiệp vụ không bị xóa vật lý. Đơn cũ vẫn xem được khi khách ngừng hoạt động.

Sale chỉ đọc khách được giao. Import Excel phải hỗ trợ thêm/cập nhật an toàn và không xóa khách hiện có nếu chưa có xác nhận mạnh.

Tổng mua, tổng trả, doanh số thuần, công nợ và lịch sử khách phải được tổng hợp từ đơn, thanh toán và ledger chuẩn, không từ cache không đáng tin.

## X. Lập đơn và backend tự tính tiền

Luồng frontend:

1. Chọn hoặc tạo nhanh khách hàng theo quyền.
2. Chọn sản phẩm cha.
3. Chọn SKU.
4. Nhập mã màu/phần trăm màu nếu có.
5. Nhập số lượng và chiết khấu dòng.
6. Nhập giảm giá đơn, phí vận chuyển và ghi chú.
7. Lưu nháp hoặc chốt đơn.

Frontend chỉ gửi dữ liệu đầu vào. Backend không tin đơn giá, tổng dòng, tổng đơn, trạng thái, người tạo, người chọn giá hoặc role do client gửi.

Backend phải:

1. Xác thực `auth.uid()` và profile.
2. Kiểm tra role và phạm vi khách hàng.
3. Kiểm tra SKU tồn tại và đang hoạt động.
4. Kiểm tra bảng giá và quyền dùng bảng giá.
5. Tự lấy đơn giá theo SKU/bảng giá.
6. Tự tính toàn bộ tiền bằng `numeric` hoặc số nguyên VND, không dùng float.
7. Kiểm tra `idempotency_key`.
8. Lưu order, order_items và snapshot.
9. Ghi thanh toán nếu có.
10. Ghi ledger công nợ và cập nhật số dư khách hàng.
11. Ghi doanh số và hoa hồng.
12. Chuyển/xóa draft phù hợp.
13. Ghi audit.

Chốt đơn không kiểm tra hoặc trừ tồn kho.

Công thức:

```text
Tiền dòng gốc = số lượng × đơn giá backend
Giảm dòng = phần trăm hoặc số tiền, không vượt tiền dòng gốc
Tiền dòng sau giảm = tiền dòng gốc - giảm dòng
Tổng trước giảm đơn = tổng tiền dòng sau giảm
Giảm toàn đơn = phần trăm hoặc số tiền, không vượt tổng trước giảm đơn
Tổng tiền hàng = tổng trước giảm đơn - giảm toàn đơn
Tổng khách cần trả = tổng tiền hàng + phí vận chuyển + thuế + phụ phí được áp dụng
Công nợ phát sinh = tổng khách cần trả - thanh toán hợp lệ
```

Phải xác nhận nghiệp vụ trước khi triển khai nếu chưa rõ phí vận chuyển là doanh thu hay khoản thu hộ. Dashboard, KPI, công nợ và báo cáo phải dùng cùng một định nghĩa.

## XI. Đơn nháp và chống tạo trùng

Nháp không tạo doanh thu, thanh toán, công nợ, sổ quỹ hoặc hoa hồng.

Sale chỉ thao tác nháp của mình. Không tự xóa nháp cũ mà không cảnh báo. Sau khi chốt, nháp phải được đánh dấu đã chuyển hoặc xóa trong cùng transaction.

Không dùng `Date.now()` cắt ngắn làm ID duy nhất. Dùng UUID/ID database, mã hiển thị từ sequence và unique constraint.

Mỗi lần chốt có `idempotency_key`:

- Cùng key, cùng payload: trả lại đơn cũ.
- Cùng key, payload khác: từ chối.
- Hai request đồng thời: chỉ tạo một đơn.
- Retry sau timeout: dùng lại đúng key.

## XII. Lịch sử và in đơn

Trạng thái chuẩn: `draft`, `settled`, `partially_returned`, `returned`, `cancelled`.

Không xóa vật lý đơn đã chốt. Hủy đơn phải tạo giao dịch đảo cho thanh toán, công nợ, doanh số và hoa hồng trong transaction; không có xử lý tồn kho.

Lịch sử hiển thị mã đơn, ngày, khách hàng, người tạo, công ty, nhãn, các tổng tiền, phí vận chuyển, đã thanh toán, công nợ và trạng thái. Bộ lọc và export phải lấy dữ liệu database theo đúng RLS.

Sau chốt phải in ngay được và in lại từ lịch sử. Bản in dùng snapshot đơn đã lưu, không phụ thuộc `state.invoiceItems` và không tính lại giá theo bảng giá hiện tại.

Các phiếu in trong phạm vi gồm hóa đơn bán lẻ, hóa đơn đại lý, phiếu giao hàng nếu còn được sử dụng, phiếu thu/chi, phiếu mua và phiếu trả hàng. Phiếu giao hàng không phát sinh nghiệp vụ kho.

## XIII. Thanh toán, công nợ khách hàng và sổ quỹ

Dùng ledger append-only `customer_debt_transactions`. Không sửa hoặc xóa ledger đã phát sinh; sửa sai bằng giao dịch đảo.

```text
Chốt đơn: nợ mới = nợ cũ + còn phải thu
Thu nợ: nợ mới = nợ cũ - số tiền thu
Trả hàng: nợ mới = nợ cũ - phần công nợ được hoàn
Hủy trả: nợ mới = nợ cũ + phần đã giảm
Hủy phiếu thu: tạo giao dịch đảo
```

Không cho tiền thu âm hoặc thu vượt công nợ nếu chưa có nghiệp vụ tiền ứng trước. Không cập nhật trực tiếp `customer.debt` mà thiếu ledger.

Sổ quỹ gồm tiền mặt, ngân hàng và ví điện tử; hỗ trợ số dư đầu kỳ, phiếu thu, phiếu chi, thu công nợ, chi nhà cung cấp, phương thức thanh toán và cờ hạch toán kết quả kinh doanh.

Phiếu đã xác nhận không bị sửa/xóa vật lý. Hủy bằng trạng thái và giao dịch đảo. Thu công nợ phải ghi cashbook và ledger trong cùng transaction.

## XIV. Trả hàng bán

Chỉ Admin và Accounting được thực hiện.

Backend phải kiểm tra đơn gốc, SKU thuộc đơn, số lượng đã bán, số lượng đã trả trước, giá hoàn và chống tạo phiếu trùng. Không tin tổng tiền hoặc trạng thái frontend gửi.

Trả hàng chỉ xử lý:

- Số lượng đã trả.
- Giá trị hoàn.
- Thanh toán hoặc công nợ.
- Doanh số.
- Hoa hồng.
- Trạng thái đơn.
- Audit log.

Trả hàng không cộng lại tồn kho.

Hủy phiếu trả không xóa vật lý; phải đảo công nợ/thanh toán, doanh số và hoa hồng, tính lại trạng thái đơn và ghi audit trong một transaction.

## XV. Nhà cung cấp, phiếu mua và công nợ nhà cung cấp

Nhà cung cấp gồm mã unique, tên, điện thoại, địa chỉ, công nợ đầu kỳ, ghi chú, tổng mua, đã thanh toán và còn phải trả.

Chuẩn hóa các bảng nếu chưa có:

- `suppliers`
- `purchases`
- `purchase_items`
- `supplier_debt_transactions`
- `purchase_payments`

Phiếu mua có trạng thái `draft`, `completed`, `cancelled`; gồm nhà cung cấp, số hóa đơn đầu vào, ngày mua, dòng hàng hóa/dịch vụ, số lượng ghi nhận, đơn giá mua, tổng tiền, đã thanh toán, còn phải trả và ghi chú.

Phiếu mua chỉ phục vụ:

- Ghi nhận mua từ nhà cung cấp.
- Tổng giá trị mua.
- Đã thanh toán.
- Còn phải trả.
- Công nợ nhà cung cấp.
- Tạo phiếu chi.
- Báo cáo mua hàng.

Phiếu mua không cộng tồn kho.

Backend tự tính tổng dòng và tổng phiếu. Khi hoàn thành phiếu mua, trong một transaction:

1. Tạo phiếu và các dòng.
2. Ghi ledger công nợ nhà cung cấp.
3. Tạo payment/phiếu chi nếu có thanh toán.
4. Cập nhật tổng hợp nhà cung cấp.
5. Ghi audit.

Hủy phiếu mua không xóa vật lý; phải đảo công nợ, đảo/hủy phiếu chi liên quan và ghi audit. Không có xử lý tồn kho.

## XVI. Dashboard, báo cáo và KPI

Dashboard và báo cáo lấy dữ liệu từ database chuẩn, không lấy số tổng từ cache hoặc tải 10.000 dòng về frontend để tự tính.

Chỉ tính dữ liệu đơn, thanh toán, ledger, trả hàng và mua hàng hợp lệ. Không tính draft, cancelled hoặc giao dịch đã bị đảo như nghiệp vụ còn hiệu lực.

Chỉ số chính:

- Doanh số gộp.
- Giá trị trả hàng.
- Doanh số thuần.
- Tiền đã thu.
- Công nợ phát sinh và đã thu.
- Tổng mua, đã trả nhà cung cấp và còn phải trả.
- Doanh số/KPI theo công ty, nhãn, Sale, quản lý, khách hàng, tỉnh và SKU.

Dashboard không tải, tính hoặc hiển thị dữ liệu kho hay sản xuất.

Query tổng hợp và phân trang phải chạy server-side và tuân thủ RLS.

## XVII. Lương và hoa hồng

Không lưu kỳ lương và điều chỉnh chỉ trong localStorage. Chuẩn hóa:

- `payroll_periods`
- `payroll_entries`
- `payroll_adjustments`
- `commission_rules`
- `commission_transactions`

```text
Lương thực nhận
= lương cơ bản
+ hoa hồng đơn hàng
+ thưởng KPI
- hoa hồng bị đảo do trả hàng/hủy đơn
- khấu trừ khác
```

Không hard-code hoa hồng 3%. Rule có thời hạn hiệu lực, phạm vi theo Sale/sản phẩm/nhãn/doanh số và được snapshot khi phát sinh.

Chốt đơn tạo hoa hồng dương. Trả hàng hoặc hủy đơn tạo giao dịch hoa hồng âm/đảo; không sửa lịch sử cũ khi rule thay đổi.

Khóa kỳ lương lưu snapshot. Mở khóa cần quyền và audit.

## XVIII. Backup, restore, đồng bộ và offline

Supabase là nguồn chính. localStorage không phải database dự phòng chính.

Nếu chưa có outbox, version, idempotency, trạng thái sync và conflict resolution an toàn thì tắt ghi nghiệp vụ offline; chỉ cho xem cache read-only và thông báo mất kết nối.

Restore chỉ dành cho Admin, bắt buộc backup, preview và dry-run; báo số dòng thêm/sửa/bỏ qua/lỗi. Không xóa dữ liệu hiện có nếu chưa xác nhận mạnh và không bỏ qua RLS/audit.

Backup/restore mới chỉ bao gồm các phân hệ trong phạm vi. Dữ liệu legacy ngoài phạm vi được giữ nguyên nhưng không được đưa trở lại luồng nghiệp vụ.

## XIX. Audit, hủy và bảo toàn lịch sử

Không xóa vật lý:

- Đơn đã chốt.
- Phiếu thu/chi đã xác nhận.
- Phiếu trả hàng.
- Phiếu mua hoàn thành.
- Ledger công nợ khách hàng/nhà cung cấp.
- Giao dịch hoa hồng.
- Kỳ lương đã khóa.

Dùng `cancelled`, `voided`, `reversed`, `inactive` hoặc soft delete.

Audit ghi actor từ `auth.uid()`, hành động, bảng, record ID, dữ liệu trước/sau, thời gian và lý do. Sale và Accounting không được sửa/xóa audit log.

## XX. Migration

Mỗi migration mới phải có thứ tự, transaction phù hợp, precondition, ghi `schema_migrations`, không xóa dữ liệu, có rollback/hướng dẫn khôi phục và có test.

Migration phải nâng cấp được staging clone và chạy được trên database sạch trong phạm vi hệ thống mới.

Không sửa migration cũ đã có thể được áp dụng. Các bảng legacy ngoài phạm vi được giữ nguyên nhưng migration/RPC mới không phụ thuộc vào chúng.

Trước triển khai: backup, kiểm kê dòng, clone staging, chạy migration, integration test, đối chiếu dữ liệu và test frontend. Chưa tự triển khai production.

## XXI. Thứ tự sửa dự án

### Giai đoạn 1

- Sản phẩm cha và quy cách/SKU.
- Bảng giá.
- Đơn hàng.
- Backend tự tính tiền.
- Transaction và idempotency chống tạo trùng.
- Snapshot và chống xóa đơn đã chốt.

### Giai đoạn 2

- Thanh toán.
- Công nợ khách hàng.
- Sổ quỹ.
- Hủy đơn và giao dịch đảo.

### Giai đoạn 3

- Trả hàng.
- Đảo công nợ/thanh toán.
- Đảo doanh số.
- Đảo hoa hồng.

### Giai đoạn 4

- Nhà cung cấp.
- Phiếu mua hàng.
- Công nợ nhà cung cấp.
- Phiếu chi.

### Giai đoạn 5

- Dashboard.
- Báo cáo.
- KPI.
- Lương và hoa hồng.

### Giai đoạn 6

- Backup và restore.
- Đồng bộ/offline an toàn.
- Phân trang và hiệu năng.
- Integration test và E2E test.

Không tạo lại module kho hoặc sản xuất ở bất kỳ giai đoạn nào.

Sau mỗi giai đoạn phải chạy unit test, SQL integration test và E2E test phù hợp; báo file, migration, dữ liệu ảnh hưởng, rollback và rủi ro. Không tự chuyển giai đoạn nếu giai đoạn hiện tại chưa đạt.

## XXII. Test bắt buộc

- Anon không đọc hoặc ghi dữ liệu nghiệp vụ.
- Sale không đọc hoặc suy ra bảng giá riêng.
- Sale gửi ID bảng giá riêng bị từ chối.
- Frontend sửa đơn giá/tổng tiền nhưng backend vẫn tính đúng.
- SKU ngừng hoạt động bị từ chối khi chốt.
- Cùng idempotency key và payload chỉ tạo một đơn.
- Cùng key nhưng payload khác bị từ chối.
- Request đồng thời chỉ tạo một đơn.
- Lỗi giữa transaction rollback toàn bộ.
- Đơn cũ không đổi khi sửa sản phẩm hoặc bảng giá.
- Draft không tạo doanh thu, công nợ, quỹ hoặc hoa hồng.
- Thu nợ không vượt công nợ.
- Hủy phiếu thu khôi phục đúng công nợ bằng giao dịch đảo.
- Hủy đơn đảo đúng thanh toán, nợ, doanh số và hoa hồng.
- Trả hàng không vượt số đã bán trừ số đã trả.
- Hủy trả hàng đảo đúng nợ, doanh số và hoa hồng.
- Phiếu mua ghi đúng công nợ nhà cung cấp và phiếu chi.
- Hủy phiếu mua đảo đúng công nợ và phiếu chi.
- Dashboard không tính draft/cancelled hoặc dữ liệu ngoài phạm vi.
- Lương không hard-code hoa hồng.
- Restore không xóa dữ liệu ngoài dự kiến.
- Sửa localStorage/sessionStorage không thể tăng quyền.
- Đăng nhập, tải dữ liệu lõi và chốt đơn hoạt động với schema chỉ gồm các phân hệ trong phạm vi.

## XXIII. Đầu ra của mỗi lượt

Trước khi sửa:

1. Phạm vi lượt này.
2. Logic hiện tại.
3. Logic cần đạt.
4. File dự kiến sửa.
5. Migration/RPC dự kiến tạo hoặc thay thế.
6. Công thức và quyết định nghiệp vụ còn thiếu.
7. Rủi ro.

Sau khi sửa:

1. File đã sửa.
2. Migration đã thêm.
3. RPC đã thêm hoặc thay thế.
4. Công thức đã chuẩn hóa.
5. Test đã chạy và kết quả.
6. Test chưa chạy được.
7. Cách giữ dữ liệu cũ.
8. Cách rollback.
9. Rủi ro còn lại.
10. Bước tiếp theo đề xuất.

Không tuyên bố hoàn thành nếu chỉ có unit test hoặc kiểm tra tĩnh mà chưa có integration test database staging thật.
