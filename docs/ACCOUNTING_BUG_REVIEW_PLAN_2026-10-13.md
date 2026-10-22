# Kế hoạch rà soát và sửa lỗi kế toán ngày 13/10/2026

Phạm vi: ba phản ánh trong ảnh về phiếu mua, tìm/tạo mã hàng đầu vào và nhập Excel hóa đơn. Tài liệu ghi nhận kế hoạch và tiến độ triển khai trong workspace; trạng thái nghiệm thu trên website kế toán đang dùng được nêu riêng bên dưới.

## Trạng thái triển khai cục bộ

Đã thực hiện phần sửa mã nguồn trong workspace:

- **KT-01:** Phiếu mua chia vùng nội dung cuộn và chân nút lưu cố định; lỗi lưu/ngày không hợp lệ được báo và giữ lại dữ liệu để thử lại.
- **KT-02:** Đã thay thông báo đọc file bằng xem trước theo từng hóa đơn, kiểm dòng và VAT, chọn khách hàng, ánh xạ SKU, chống nhập trùng và lưu riêng từng hóa đơn thành đơn nháp. Không tự ghi nhận thanh toán. Mẫu đã kiểm lại: 26 dòng, 10 hóa đơn, không có lỗi dữ liệu; hai hóa đơn lệch 1 đồng nếu tính VAT trên tổng, nên giữ nguyên thuế đã làm tròn theo từng dòng.
- **KT-03:** Có gợi ý mã/tên từ các phiếu mua trước; mã mới vẫn được nhập trực tiếp và sẽ thành gợi ý sau khi lưu phiếu.
- Kiểm tra cục bộ: `npm run release:check` đã qua, gồm 611 test, kiểm cấu trúc/migration và build.

Phần nghiệm thu trên staging chưa thực hiện. Migration `0107` cần được áp dụng trên đúng staging trước khi dùng nhập Excel; chưa thay đổi database hoặc phát hành website.

## 1. Thứ tự xử lý

| Mã | Ưu tiên | Phản ánh | Việc cần làm | Điều kiện nghiệm thu |
| --- | --- | --- | --- | --- |
| KT-01 | P1 | Phiếu mua không thấy chỗ lưu | Tái hiện ở chiều cao màn hình thấp và mức zoom thực tế; sửa bố cục form để nội dung cuộn và vùng nút luôn truy cập được; rà luồng lưu và báo lỗi | Kế toán thấy nút hoàn thành, lưu được phiếu, tải lại vẫn thấy phiếu và số tiền đúng |
| KT-02 | P1 | Excel báo nạp 26 dòng nhưng đơn trống, lịch sử không có đơn | Thay xử lý chỉ đọc file bằng quy trình kiểm tra, chia hóa đơn, xem trước, ánh xạ và lưu rõ ràng | File mẫu được nhận diện thành 10 nhóm hóa đơn với 26 dòng hàng; kết quả lưu và lịch sử phản ánh đúng trạng thái |
| KT-03 | P2 | Gõ mã/tên đầu vào không có gợi ý; cần tạo mã mới ngay tại dòng | Bổ sung tìm kiếm hàng hóa/dịch vụ đã có và tạo mã đầu vào tại chỗ; giữ khả năng nhập trực tiếp | Chọn mã cũ tự điền tên/ĐVT; tạo mã mới rồi dùng lại được trong phiếu tiếp theo |

P1: đang cản trở hoàn thành công việc hoặc báo thành công khi nghiệp vụ chưa được thực hiện. P2: thiếu tiện ích nhập liệu/danh mục, xử lý sau khi luồng lưu hoạt động ổn định.

## 2. Kết quả rà soát sơ bộ và bằng chứng

### KT-01: nút lưu phiếu mua

- `js/components/purchases.js:178` đã có nút submit “Hoàn thành phiếu mua”; sự kiện tại dòng 365 gọi `dbCreatePurchase`. Vì vậy cần kiểm tra khả năng hiển thị/truy cập nút trước khi thêm nút mới.
- `styles/base.css:5704` giới hạn chiều cao cửa sổ và đặt `overflow: hidden`; `.purchase-entry-modal-body` có cuộn tại dòng 5724. Tuy nhiên body và footer nằm trong một phần tử `form` chưa có cấu trúc co giãn/giới hạn chiều cao riêng. Đây là giả thuyết có căn cứ cho tình trạng footer bị cắt, chưa được xác nhận bằng tái hiện trên trình duyệt.
- Hướng sửa dự kiến: modal và form chia chiều cao bằng flex, form/body có `min-height: 0`, body chiếm phần còn lại và cuộn, header/footer không co; kiểm tra bảng dòng hàng nhiều cột khi màn hình hẹp.
- `js/services/supabase.js:4502` lưu qua `rpc_create_purchase`; database tính tiền và công nợ. Sau sửa giao diện phải kiểm tra cả ghi dữ liệu và tải lại, không chỉ việc nhìn thấy nút.
- Kiểm tra thêm `try/finally` cho nút đang lưu, lỗi ngày/số tiền, mất kết nối và giữ nội dung để thử lại. Phản hồi thất bại phải cụ thể và không xóa dữ liệu người dùng đang nhập.

### KT-02: nhập Excel

- Đã xác nhận trong `js/components/invoice.js:2822`: handler chỉ đọc workbook, lấy sheet đầu tiên, gọi `sheet_to_json` rồi hiện thông báo thành công tại dòng 2845.
- Handler chưa ánh xạ dòng vào `state.invoiceItems`, chưa render lại bảng, chưa gọi lưu nháp hoặc chốt đơn. Đây là nguyên nhân trực tiếp của thông báo “26 dòng” nhưng bảng đơn/lịch sử trống trong phiên bản mã nguồn đang kiểm tra.
- Lưu nháp và chốt đơn là các hành động riêng hiện có, dùng `dbSaveOrder` và `dbConfirmOrder`. Chức năng nhập mới phải thể hiện rõ bước đọc, bước kiểm tra và bước lưu.
- File có nhiều hóa đơn. Không được đưa toàn bộ 26 dòng vào một đơn đang soạn.
- Khi nghiệm thu lịch sử cần xét bộ lọc: dữ liệu nguồn thuộc tháng 9 và tháng 10; đơn nháp có bộ lọc riêng. Không thấy trong mặc định hiện tại chưa đủ chứng minh lưu thất bại.

### KT-03: tìm/tạo mã đầu vào

- `js/components/purchases.js:116` và `:117` hiện dùng input văn bản cho mã và tên. Các sự kiện dòng hàng chỉ cập nhật tiền/xóa dòng; chưa có gợi ý hoặc liên kết danh mục.
- Backend yêu cầu mã, tên, số lượng dương và đơn giá không âm; mã mới nhập trực tiếp có thể được lưu trong dòng phiếu. Điều này chưa tạo một danh mục đầu vào có thể tìm lại trên giao diện.
- Thiết kế đề xuất: gõ mã hoặc tên hiện danh sách gợi ý; chọn một mục điền mã/tên/ĐVT; khi chưa có mục phù hợp hiện “Tạo hàng hóa/dịch vụ mới”. Đơn giá mua vẫn là giá của lần mua và được người dùng rà lại.
- Rà danh mục hiện có trước khi quyết định schema. Nếu chưa có loại danh mục phù hợp, bổ sung danh mục đầu vào nhẹ, có mã duy nhất trong workspace và quyền tạo cho kế toán/quản trị. Không tự đưa nguyên liệu đầu vào vào danh sách bán hàng.
- Danh mục chỉ hỗ trợ ghi phiếu mua. Dòng chứng từ giữ bản chụp mã/tên/ĐVT để đổi tên danh mục sau này không làm đổi phiếu đã lưu.

## 3. File mẫu và số kiểm soát

Nguồn: `D:/Downloads/Invoice_20261013.xlsx`, sheet `Sheet1`.

- 43 cột, 26 dòng dữ liệu thực ở dòng 2–27; vùng sheet khai báo tới dòng 3597. Import phải bỏ các dòng trống/định dạng thừa.
- 10 giá trị `MaHD` khác nhau; có 15 mã hàng khác nhau. Đếm số dòng hàng không phải đếm số hóa đơn.
- Ngày nguồn từ 12/09/2026 đến 12/10/2026, dạng `dd/MM/yyyy`.
- Tất cả dòng có `ThueSuat = 8`, `TienTe = VND`; số tiền dưới đây được đọc từ dữ liệu nguồn, không phải quy định thuế được đề xuất.
- `MaKhachHang` trống toàn bộ. Có dòng ghi người tiêu dùng và có nhóm ghi tên/mã số thuế/địa chỉ bên mua. Không tự ghép khách chỉ theo tên hoặc tự tạo khách trùng.
- `HinhThucThanhToan` là “Tiền mặt/Chuyển khoản”; file không có số tiền đã thanh toán. Không suy ra đã trả hết hoặc tự chốt phát sinh công nợ từ trường này.
- `SoLuong × DonGia` khớp `ThanhTien` ở cả 26 dòng. `TienThue` khớp cách làm tròn 8% theo từng dòng.

| MaHD | Ngày nguồn | Dòng Excel | Số dòng hàng | Tổng ThanhTien (đ) | Tổng TienThue (đ) |
| --- | --- | --- | ---: | ---: | ---: |
| 10 | 12/10/2026 | 2–3 | 2 | 4.590.259 | 367.221 |
| 11 | 12/10/2026 | 4–6 | 3 | 3.533.030 | 282.642 |
| 9 | 08/10/2026 | 7–8 | 2 | 3.692.613 | 295.409 |
| 7 | 07/10/2026 | 9 | 1 | 4.250.880 | 340.070 |
| 8 | 07/10/2026 | 10–12 | 3 | 4.262.980 | 341.039 |
| 5 | 05/10/2026 | 13–15 | 3 | 4.022.438 | 321.795 |
| 6 | 05/10/2026 | 16–18 | 3 | 4.579.891 | 366.391 |
| 3 | 30/09/2026 | 19–22 | 4 | 47.435.672 | 3.794.854 |
| 2 | 17/09/2026 | 23–25 | 3 | 45.531.070 | 3.642.485 |
| 1 | 12/09/2026 | 26–27 | 2 | 2.847.684 | 227.815 |
| Tổng | | | 26 | 124.746.517 | 9.979.721 |

Tổng `ThanhTien + TienThue` của file: **134.726.238 đ**. Đây là số kiểm soát dữ liệu nguồn, không đồng nghĩa số tiền đã thu hoặc công nợ phải ghi.

Rủi ro cần xử lý cùng KT-02: `readInvoiceVatDetails` trong `js/components/invoice.js:28` hiện làm tròn VAT trên tổng tiền. Với MaHD 8, cách này cho 341.038 đ thay vì 341.039 đ trong file; với MaHD 2 cho 3.642.486 đ thay vì 3.642.485 đ. Hai sai lệch triệt tiêu khi cộng cả file nên chỉ kiểm tổng file sẽ bỏ sót lỗi. Cần đối chiếu từng hóa đơn và quy định cách lưu/tính lại tương thích với chứng từ nguồn ở cả frontend/backend.

## 4. Cách triển khai chức năng nhập

Luồng đề xuất: chọn file → nhận diện cấu trúc và các nhóm hóa đơn → xem trước/lỗi theo dòng → chọn nhóm cần nhập và xử lý ánh xạ → lưu nháp → kế toán kiểm tra và chốt khi thông tin thanh toán, công nợ đã được xác định.

Nếu chỉ muốn đưa một hóa đơn vào màn đang soạn, chọn một nhóm từ phần xem trước. Khi màn đang có dữ liệu, phải có lựa chọn rõ ràng trước khi thay thế. Nhập nhiều nhóm dùng danh sách xem trước và lưu các đơn riêng, không gộp chúng vào một đơn.

| Dữ liệu nguồn | Xử lý dự kiến |
| --- | --- |
| MaHD | Nhóm dòng thành hóa đơn; lưu mã nguồn riêng với ID nội bộ của hệ thống |
| NgayHoaDon | Parse ngày Việt Nam/Excel serial theo helper hiện có, kiểm tra ngày hợp lệ, giữ ngày nghiệp vụ |
| MaKhachHang, TenNguoiMua, TenDonVi, MaSoThue, DiaChiKhachHang | Đề xuất khách phù hợp hoặc khách vãng lai; kế toán xác nhận ánh xạ; giữ thông tin bên mua của chứng từ |
| MaHang, TenHangHoa, DVT | Ghép đúng SKU/quy cách/đơn vị hiện có; hiển thị mục không tìm thấy hoặc khớp nhiều; không tự chọn theo tên gần giống |
| SoLuong, DonGia | Kiểm số hợp lệ và quyền dùng giá nguồn; không lấy giá bảng hiện tại thay giá chứng từ một cách im lặng |
| ThanhTien | Đối chiếu với tính toán theo số lượng, đơn giá, chiết khấu; giữ giá trị nguồn để kiểm tra |
| ThueSuat, TienThue | Đối chiếu theo từng dòng và hóa đơn; giữ cách làm tròn nguồn hoặc chặn kèm giải thích nếu chưa hỗ trợ |
| HinhThucThanhToan | Thông tin nguồn; không thay cho số tiền đã trả |
| SoTT, TinhChat, Ghichu và các cột giảm trừ | Giữ thứ tự; nhận diện tính chất/chiết khấu/ghi chú, báo rõ nếu loại dữ liệu chưa được hỗ trợ |

Các yêu cầu kỹ thuật cần có:

1. Tách parser/validation/grouping ra module miền để kiểm thử bằng fixture đã bỏ dữ liệu định danh cá nhân; dùng file gốc cho nghiệm thu có quyền truy cập.
2. Kiểm tra header và sheet phù hợp, bỏ dòng rỗng, không chạy/diễn giải nội dung ô như hướng dẫn. Thiếu cột hoặc công thức không có giá trị đọc được phải được báo rõ.
3. Chỉ ghép nhóm sau khi kiểm tra các thông tin cấp hóa đơn trong nhóm nhất quán. File khác có thể trùng MaHD giữa nguồn/ngày/đơn vị phát hành; phải xác định nguồn và khóa chứng từ phù hợp trước khi lưu.
4. SKU có khoảng trắng, dấu gạch và ký tự tiếng Việt cần chuẩn hóa có kiểm soát; nếu chuẩn hóa tạo nhiều kết quả thì bắt buộc chọn lại. Không gộp các dòng chỉ vì trùng SKU.
5. Lưu nháp chưa phát sinh công nợ; dùng đường lưu/chốt chuẩn của hệ thống, giữ quyền giá nhập tay và cách ly workspace. Chốt chỉ sau khi kiểm tra trạng thái tài chính của chứng từ nguồn.
6. Chống nhập trùng theo workspace, nguồn và khóa chứng từ bền vững. Đổi tên file hoặc nhập lại file xuất mới vẫn nhận ra chứng từ đã nhập. Cùng khóa nhưng nội dung khác phải báo xung đột, không tự ghi đè đơn đã chốt.
7. Lưu từng hóa đơn nguyên tử. Nếu lưu theo lô, hiển thị rõ nhóm đã lưu/thất bại/bỏ qua và thử lại phần thất bại; tránh báo cả lô thành công khi chỉ một phần được ghi.
8. Thông báo dùng kết quả thực: “Đã đọc 26 dòng thuộc 10 hóa đơn”, “Đã lưu X đơn nháp”, “Đã chốt X đơn”. Thông báo chỉ đọc file không được ngụ ý đã lưu.
9. Khi mở lịch sử sau nhập, dùng bộ lọc trạng thái và khoảng ngày phù hợp với các đơn vừa lưu; vẫn cho người dùng đối chiếu dữ liệu đã lưu sau tải lại trang.

Trước phần chốt tài chính cần thống nhất với kế toán: đây là nhập chứng từ lịch sử đã hạch toán hay tạo đơn mới; giữ giá/thuế chứng từ nguồn ra sao; số đã thu còn thiếu lấy từ đâu; và quy tắc ánh xạ người mua không có mã. Phần giao diện, parser, xem trước và kiểm thử có thể triển khai độc lập trong khi làm rõ các điểm này.

## 5. Các bước thực hiện và dự kiến thời gian

Ước lượng cho một lập trình viên và kế toán tham gia nghiệm thu: **4–6 ngày làm việc** sau khi xác nhận phiên bản đang chạy và quy tắc nhập. Đây là ước lượng, sẽ cập nhật sau bước tái hiện; bổ sung quy trình nhập chứng từ lịch sử riêng có thể làm tăng phạm vi.

| Bước | Công việc | Phụ trách | Dự kiến | Kết quả bàn giao |
| --- | --- | --- | --- | --- |
| 1 | Đối chiếu URL/workspace, phiên bản website với mã nguồn; tái hiện 3 tình huống đúng tài khoản kế toán, màn hình và zoom; ghi console/network có liên quan | Lập trình viên + kế toán | 0,5 ngày | Mỗi lỗi có bước tái hiện, bằng chứng và phạm vi ảnh hưởng |
| 2 | Sửa vùng cuộn/nút lưu KT-01; kiểm tra lưu, thông báo lỗi, giữ dữ liệu và chống bấm lặp | Lập trình viên | 0,5 ngày | Phiếu mua lưu được và đối chiếu dữ liệu sau tải lại |
| 3 | KT-02: parser, chia nhóm, preview, ánh xạ, giá/thuế, lưu nháp, chống trùng, trạng thái và lịch sử | Lập trình viên; kế toán chốt quy tắc dữ liệu | 2–3 ngày | Import mẫu 10 hóa đơn/26 dòng, đối chiếu từng hóa đơn |
| 4 | KT-03: gợi ý mã/tên, tạo mới tại dòng, ĐVT, quyền tạo và danh mục trong workspace | Lập trình viên | 0,5–1 ngày | Mã đầu vào mới dùng lại được, không làm đổi chứng từ cũ |
| 5 | Kiểm thử hồi quy, kế toán nghiệm thu trên staging, chuẩn bị bản phát hành và đối chiếu sau phát hành | Lập trình viên + kế toán | 0,5–1 ngày | Checklist có kết quả và bằng chứng cho các điều kiện dưới đây |

Thứ tự KT-01 trước KT-02 nhằm khôi phục thao tác hoàn thành phiếu mua sớm. Trong KT-02, sửa thông báo gây hiểu nhầm có thể bàn giao trước luồng import đầy đủ.

## 6. Checklist kiểm thử và nghiệm thu

### Phiếu mua và danh mục đầu vào

- Màn hình 1366×768, 1280×720 và màn hình hẹp; zoom 100%, 125%, 150%; 1 dòng và nhiều dòng tới giới hạn backend 100 dòng. Header/footer và nút hoàn thành phải truy cập được, nội dung cuộn đúng.
- Tab bàn phím/Enter không vô tình submit khi đang chọn gợi ý; nút thêm/xóa/tạo mã không làm mất form. Dropdown gợi ý không bị cửa sổ hoặc bảng cắt.
- Thiếu nhà cung cấp/mã/tên, số lượng 0/âm, đơn giá âm, tổng phiếu 0, thanh toán lớn hơn tổng: báo lỗi dễ hiểu và giữ dữ liệu.
- Lưu bình thường, bấm hai lần, phản hồi chậm, mất mạng trước/sau gửi, thử lại: không sinh phiếu mua/phiếu chi/công nợ trùng.
- Tải lại xác nhận dòng hàng, nhà cung cấp, ngày, tổng mua, đã thanh toán, còn phải trả. Phiếu chi và ledger tăng đúng một lần; hủy thử trên dữ liệu kiểm thử đảo đúng nghiệp vụ.
- Gõ mã/tên cũ, tìm không thấy, tạo mã mới, mã trùng, mã khác hoa/thường, dấu tiếng Việt, mục ngừng dùng; chuyển workspace không thấy danh mục của workspace khác.
- Kế toán/quản trị được thao tác theo quyền; vai trò không có quyền bị từ chối ở backend, không chỉ ẩn nút.

### Nhập Excel và lịch sử

- File mẫu: nhận đúng 26 dòng, 10 nhóm, 15 SKU nguồn; đối chiếu 26 dòng sau lưu và mọi nhóm trong bảng số kiểm soát.
- Không sinh 26 đơn theo số dòng, không gộp 10 hóa đơn thành 1 đơn. Không tự bù hóa đơn số 4 vì file không có mã này.
- Giữ ngày 12/09/2026, 17/09/2026, 30/09/2026 và các ngày tháng 10; không đổi sang ngày nhập 13/10/2026 hoặc hiểu 12/09 thành 09/12.
- Tổng nguồn 124.746.517 đ tiền hàng, 9.979.721 đ thuế, 134.726.238 đ cộng hai trường. Kiểm riêng MaHD 8 và 2 để bắt sai lệch làm tròn 1 đồng.
- SKU không tồn tại, SKU ngừng dùng, trùng kết quả ánh xạ, thiếu khách, khác đơn vị, không có giá, giá nguồn khác bảng giá: hiện rõ và không tự sửa giá trị.
- File nhiều sheet, thiếu/sai header, dòng rỗng tới cuối sheet, số dạng chuỗi có dấu phân cách, ngày Excel serial, file hỏng, nhóm có thông tin mâu thuẫn: không báo thành công giả.
- Một file có nhiều thuế suất hoặc tính chất dòng chưa hỗ trợ: hiển thị lỗi cụ thể; không ép về cấu hình chung làm sai tiền.
- Nhập lại cùng file, đổi tên file, file xuất lại với thứ tự dòng khác: không tạo trùng; cùng mã nhưng dữ liệu đổi: báo xung đột.
- Kiểm lưu nháp ở bộ lọc nháp, kiểm chốt ở lịch sử hoàn thành với khoảng 12/09–12/10/2026; tải lại hoặc mở phiên khác vẫn có dữ liệu.
- Lô có một hóa đơn lỗi: kết quả từng nhóm rõ ràng, nhóm lỗi không có dữ liệu dở dang; thử lại không ghi trùng nhóm đã thành công.
- Nhập/lưu nháp không tăng doanh số/công nợ. Chốt theo dữ liệu thanh toán đã xác nhận, kiểm ledger/tiền thu và quyền giá nguồn. Không tự coi “Tiền mặt/Chuyển khoản” là đã thanh toán.

### Kiểm tra kỹ thuật trước phát hành

- Bổ sung unit test cho parser, grouping, validation, khóa chống trùng và rounding; E2E cho footer phiếu mua và import tới lịch sử. Các test kiểm chuỗi mã nguồn hiện có chưa chứng minh được hai hành vi giao diện này.
- Tái sử dụng kiểm thử purchase RPC/supplier debt, order pricing, dates và history. Chạy integration trên staging cho những thay đổi liên quan ghi dữ liệu, quyền và tenant.
- Sau các kiểm thử tập trung, chạy `npm run release:check` theo quy trình dự án khi chuẩn bị bản sửa để phát hành.
- Nếu cần schema mới, tạo migration kế tiếp hợp lệ và kiểm chuỗi migration. Mã nguồn đang có thay đổi VAT chưa commit và file migration 0107; phải đối chiếu nhánh/Cloud trước khi chọn số migration hoặc triển khai.
- Nghiệm thu staging bằng tài khoản kế toán trước phát hành; dùng chứng từ kiểm thử có thể nhận diện. Ghi phiên bản bản phát hành và đối chiếu sau phát hành để kế toán biết đang kiểm đúng bản.

## 7. Tiêu chí đóng việc

KT-01, KT-02, KT-03 chỉ được đánh dấu hoàn tất khi có kết quả nghiệm thu tương ứng; báo đọc file, hiển thị nút hoặc test unit riêng lẻ chưa đủ. Bản bàn giao cần ghi lỗi đã sửa, các trường hợp đã kiểm, kết quả đối chiếu từng chứng từ, phiên bản triển khai và điểm còn giới hạn nếu có.

Rà soát hiện tại chỉ đọc ảnh, workbook và mã nguồn, đồng thời bổ sung tài liệu kế hoạch này. Chưa chạy lại giao diện kế toán, chưa xác minh database đang vận hành và chưa sửa/triển khai chức năng.
