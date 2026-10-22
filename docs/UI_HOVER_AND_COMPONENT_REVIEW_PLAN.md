# Kế hoạch rà soát hover và thống nhất chi tiết giao diện SoVie

Ngày lập: 2026-10-01

## Mục tiêu

Rà toàn bộ giao diện đang sử dụng để sửa nút đổi màu sai khi rê chuột, icon hoặc viền bo tràn khỏi nút, và các bề mặt bị chồng lớp kiểu cũ. Kết quả cần thống nhất ở trạng thái bình thường, hover, focus bàn phím, nhấn, được chọn và vô hiệu hóa; đồng thời giữ nguyên chức năng và quyền truy cập của từng màn.

Kế hoạch này tiếp nối phần chuẩn hóa CSS còn mở trong [UI_LEGACY_CLEANUP_PLAN.md](UI_LEGACY_CLEANUP_PLAN.md). Phạm vi là giao diện web hiện hành, gồm landing, đăng nhập, điều hướng, các panel nghiệp vụ, menu, bộ lọc, bảng, form và modal. CSS in chỉ kiểm tra hồi quy nếu sửa quy tắc dùng chung có thể ảnh hưởng bản in.

## Dấu hiệu đã thấy trong mã nguồn

Đây là các **đầu mối cần xác minh bằng giao diện thực tế**, chưa phải kết luận rằng mọi vị trí dùng selector đều đang lỗi:

| Vị trí | Xung đột hoặc rủi ro cần kiểm tra |
| --- | --- |
| `styles/base.css:1814-1889`, `:3751-3764`, `:4927-4950` và `styles/app.css:9318-9379` | Cùng nhóm `.btn-*` được định nghĩa nhiều lần; màu, nền, bóng và hover phụ thuộc thứ tự nạp và độ ưu tiên selector. |
| `styles/base.css:498-525`, `:1886-1895` và `styles/app.css:8359-8370` | Nút icon cỡ 22 px hoặc nút tròn 32 px gặp `min-height: 36px` và bo tròn toàn cục; cần đo kích thước thực tế để xác định nguyên nhân icon hoặc viền nằm ngoài. |
| `styles/app.css:8034-8041` | `button:hover` tác động đến mọi nút, kể cả nơi có hiệu ứng hover riêng. |
| `styles/app.css:11303-11330` | Nút thao tác trong bảng và thẻ bị tô lại hàng loạt, có thể che màu phân biệt thao tác sửa, xóa hoặc in. |
| `styles/app.css:11493-11535`, `:12465-12479` | Nút header và nút lịch sử có thêm các lớp override theo ngữ cảnh; cần so sánh normal/hover của chữ, SVG, nền và viền. |
| `index.html:46-49`, `DESIGN.md` | Thứ tự nạp hiện là `base.css`, `app.css`, `landing.css`, `print.css`; tài liệu thiết kế đã có token và quy ước dùng Lucide, cần dùng làm chuẩn đối chiếu. |

Các file CSS hiện có nhiều `!important`, nên không dùng cách thêm một lớp override cuối file làm phương án sửa chính. Mỗi lỗi phải truy ra selector thắng trong **Computed Styles** rồi chỉnh hoặc bỏ quy tắc ở nơi sở hữu thành phần.

## Phạm vi rà soát và thứ tự ưu tiên

| Ưu tiên | Nhóm màn/điều khiển | Nội dung kiểm tra |
| --- | --- | --- |
| P0 | Điều hướng, đăng nhập, nút chính; thao tác sửa/xóa/thanh toán trong bảng và thẻ | Màu sai gây khó đọc hoặc hiểu nhầm hành động; icon/viền tràn; hover che mất trạng thái đang chọn hoặc vô hiệu hóa. |
| P1 | Dashboard, đơn hàng, lịch sử, khách hàng, sản phẩm, bảng giá, nhà cung cấp, Phiếu mua hàng, Sổ quỹ | Nút có icon, bộ lọc, dropdown, phân trang, modal, nút thêm nhanh và các thao tác sinh bằng JavaScript. |
| P2 | Người dùng, cấu hình, báo cáo, quản trị nền tảng, onboarding, landing | Đồng nhất chi tiết, bóng đổ, viền bo, chuyển động và các trường hợp ít dùng hơn. |

Rà theo vai trò có quyền nhìn thấy điều khiển: platform, owner/admin, kế toán và nhân viên bán hàng. Không suy ra CSS dư chỉ vì selector không có trong HTML tĩnh; nhiều nút được tạo từ `js/components/*.js`.

## Quy trình thực hiện

### 1. Lập danh mục lỗi và mốc hình ảnh

1. Chạy bản hiện tại ở kích thước 390, 768, 1199, 1200 và 1440 px. Với mỗi màn đang dùng, chụp trạng thái bình thường, hover, focus bàn phím, nhấn/được chọn và vô hiệu hóa nếu có. Mở menu, modal, hàng chi tiết và bộ lọc trước khi chụp các điều khiển bên trong.
2. Ghi mỗi lỗi vào một bảng với: màn/role, selector hoặc ID, ảnh hoặc bước tái hiện, màu và kích thước thực tế, quy tắc CSS đang thắng, mức P0–P2 và trạng thái xử lý. Tách lỗi màu/độ tương phản khỏi lỗi hình học như icon tràn, hai viền, hai nền hoặc bo góc không khớp.
3. Dùng DevTools xem `Computed Styles`, kích thước hộp, pseudo-element `::before`/`::after`, `outline`, `box-shadow`, `overflow` và `z-index`. Ghi cả style inline từ HTML/template JS nếu nó đang chặn quy tắc mới.

**Xong khi:** Có danh mục tái hiện được và ảnh mốc cho mọi nhóm màn; các lỗi P0 đã xác định được quy tắc gây xung đột.

### 2. Chốt hợp đồng cho thành phần tương tác

1. Dựa trên token trong `styles/base.css` và `DESIGN.md`, định nghĩa một bảng màu cho primary, secondary, success, warning, danger, ghost/icon và trạng thái normal/hover/focus/pressed/selected/disabled. Chữ và SVG phải cùng ý nghĩa màu; hành động nguy hiểm không đổi sang màu của hành động thường khi hover.
2. Chốt kích thước và hình dạng cho nút thường, nút nhỏ, nút chỉ có icon, nút tròn, ô nhập và chip. Một thành phần chỉ có một viền và một bề mặt nền nhìn thấy; icon nằm trong vùng nút, có kích thước và căn giữa ổn định. Giữ dấu focus bàn phím rõ ràng, phân biệt nó với viền thừa do CSS cũ.
3. Ghi rõ thành phần nào được nâng lên, đổi bóng hoặc đổi nền khi hover. Giảm chuyển động ở chế độ `prefers-reduced-motion`; trên thiết bị không có hover, điều khiển vẫn có trạng thái nhấn và focus dễ nhận biết.

**Xong khi:** Có bảng chuẩn để đối chiếu mọi sửa đổi, không chọn màu hay bán kính riêng tùy từng màn.

### 3. Sửa lớp dùng chung trước

1. Hợp nhất các quy tắc `.btn-*`, `.icon-btn`, `.btn-circle` và SVG thuộc nút vào chủ sở hữu rõ ràng trong `styles/base.css`. Rà các ràng buộc `width`, `height`, `min-width`, `min-height`, `padding`, `box-sizing`, `line-height` và `border-radius` cùng nhau để nút không bị kéo méo.
2. Thu hẹp hoặc bỏ các quy tắc hover toàn cục không phân biệt ngữ cảnh. Tránh `transition: all` ở nút; chỉ chuyển tiếp thuộc tính cần thiết. Dùng `currentColor` cho SVG khi icon phải đổi màu cùng chữ.
3. Giới hạn quy tắc riêng cho landing dưới `#landing-page`, ứng dụng dưới `#app-layout`; giữ `styles/print.css` độc lập. Bỏ override và `!important` trùng lặp sau khi xác nhận quy tắc thay thế đã bao phủ normal và các trạng thái tương tác.

**Xong khi:** Các nút mẫu trong harness hiển thị đúng ở mọi trạng thái mà không cần thêm override cuối file; số chuỗi định nghĩa trùng cho cùng thành phần giảm.

### 4. Sửa theo màn và kiểm tra luồng

Đi theo P0 rồi P1, P2. Với mỗi màn: sửa CSS tại module sở hữu, đồng thời sửa markup/class trong `index.html` hoặc template `js/components/*.js` nếu một điều khiển đang mang lớp của hai kiểu khác nhau. Xóa wrapper hoặc pseudo-element trang trí cũ chỉ khi đã xác minh nó không còn phục vụ trạng thái hiện hành. Sau mỗi màn, kiểm tra thao tác click, quyền hiển thị, menu/modal, loading và dữ liệu rỗng.

Ưu tiên các trường hợp có nhiều lớp trên một nút, ví dụ `btn btn-secondary btn-sm btn-circle`, nút icon trong bảng, nút thêm nhanh ở đơn hàng và các nút của lịch sử. Đối với bảng rộng, kiểm tra hover hàng không che nút thao tác và không làm lệch viền ô.

**Xong khi:** Mỗi lỗi trong danh mục có ảnh trước/sau và quy tắc gây lỗi đã được chỉnh hoặc loại bỏ.

### 5. Nghiệm thu và phòng tái phát

- So sánh ảnh normal/hover/focus ở các kích thước đã nêu, kiểm tra thêm 320 px cho những nút nằm trong modal hoặc thanh công cụ hẹp. Không có icon, viền, bóng hoặc nền thừa nằm ngoài nút; không có tràn ngang cấp trang.
- Kiểm tra bằng bàn phím: Tab tới được các nút, focus nhìn rõ, Enter/Space hoạt động; nút disabled không phản ứng như nút đang dùng. Chữ và icon vẫn dễ đọc ở từng trạng thái.
- Thêm kiểm tra trực quan hoặc browser fixture cho những lỗi đại diện có nguy cơ tái phát: nút tròn, nút icon bảng, primary/danger, menu, modal và header. Kiểm tra bằng computed style và hình học của hộp, không chỉ tìm chuỗi CSS trong file.
- Chạy các bài kiểm tra giao diện liên quan, `npm run verify:structure` và `npm run build`. Rà nhanh bản in sau thay đổi ở `base.css`. Chỉ kết thúc khi mọi lỗi P0/P1/P2 trên các màn đang dùng đã được xử lý và đối chiếu lại.

## Cách chia thay đổi

Thực hiện thành các phần nhỏ có thể xem diff và quay lại riêng: **(1)** chuẩn nút và icon dùng chung, **(2)** điều hướng/header và bảng thao tác, **(3)** form/modal và từng màn nghiệp vụ, **(4)** landing/onboarding và nghiệm thu. Workspace hiện có nhiều thay đổi chưa commit trong `index.html`, `styles/app.css` và các module JavaScript; trước mỗi phần cần xem diff đang có để giữ nguyên công việc song song.

## Kết quả triển khai — 2026-10-01

### Chuẩn nút đã áp dụng

| Kiểu | Bình thường | Hover |
| --- | --- | --- |
| Primary | Xanh `#0b6cf2` → `#0757d3`, chữ trắng | Xanh đậm hơn, giữ chữ trắng |
| Secondary | Nền trắng, chữ slate, viền slate | Nền `#f8fafc`, chữ đậm hơn |
| Success/teal | Xanh lá, chữ trắng | Xanh lá đậm hơn |
| Warning | Nền amber nhạt, chữ nâu đậm | Amber đậm hơn, chữ vẫn dễ đọc |
| Danger | Đỏ `#dc2626`, chữ trắng | Đỏ đậm `#b91c1c`, không đổi sang màu thao tác thường |

Nút chuẩn cao 38 px trên màn desktop; quy tắc chạm trên màn hẹp giữ vùng bấm tối thiểu 44 px. Nút nhỏ dùng 32 px; nút tròn dùng hộp 32×32 px; nút icon thông thường dùng 32×32 px; icon sửa/xóa trong picker giữ 22×22 px. SVG theo `currentColor`. Viền focus bàn phím vẫn hiện rõ; nút `disabled` và `aria-disabled` không nhận hover hoặc hiệu ứng nhấn.

### Thay đổi đã thực hiện

- Chuyển chủ sở hữu `.btn`, các biến thể màu, `.icon-btn`, `.btn-circle` và kích thước SVG về nhóm nút trong `styles/base.css`; gỡ các nhóm định nghĩa dùng chung lặp lại trong `styles/app.css`.
- Thu hẹp transition về màu, nền, viền, bóng và chuyển động được dùng; bỏ hiệu ứng phóng to 1.06 lần của icon bảng gây lấn sang nút cạnh bên.
- Giữ màu theo ngữ nghĩa cho thao tác bảng và lịch sử; sửa hover của nút phụ trên hero nền tối, nút thêm nhanh hóa đơn, header, menu, bộ lọc, phân trang, landing và đăng nhập.
- Giữ trạng thái đang chọn khi hover ở các nút chuyển chế độ; thêm điều kiện loại trừ cho nút bị vô hiệu hóa. Bộ chọn giảm chuyển động và style in vẫn độc lập.
- Thêm [fixture kiểm tra tương tác](../tests/ui-interaction-harness.html) cho nút chuẩn, icon/picker, nút tròn, phân trang, bảng, lịch sử, thêm nhanh hóa đơn, hero, modal và landing.

### Kiểm tra sau sửa

- Dùng browser fixture để đọc computed style và kích thước hộp ở 320, 390, 768, 1199, 1200 và 1440 px. Không có tràn ngang cấp trang; picker icon vẫn 22×22 px, icon bảng 32×32 px và nút thêm nhanh không đổi kích thước.
- Hover giữ màu trắng cho nút xóa trên nền xanh đậm; nút `aria-disabled` giữ trạng thái bình thường; nút tròn không phóng to; focus bằng Tab có viền nhìn thấy. Console browser không có lỗi.
- Chạy 23 kiểm tra giao diện liên quan: tất cả đạt; `npm run verify:structure` đạt; `npm run build` tạo bundle staging thành công; `git diff --check` không có lỗi whitespace. `styles/print.css` không định nghĩa nút hoặc icon nên không bị ảnh hưởng bởi chuẩn dùng chung.