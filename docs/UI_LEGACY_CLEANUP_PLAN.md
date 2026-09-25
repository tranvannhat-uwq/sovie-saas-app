# Kế hoạch hợp nhất giao diện và gỡ lớp CSS cũ

Ngày lập: 2026-09-24

## Mục tiêu

Giữ giao diện SoVie hiện hành cho trang giới thiệu (`#landing-page.ref-page`)
và ứng dụng (`#app-layout` với điều hướng ngang), rồi xóa markup, JavaScript
giao diện và CSS của các phiên bản đã bị thay thế. Mỗi lớp chỉ được xóa sau khi
quy tắc còn sử dụng đã có chủ sở hữu mới và màn hình liên quan đã được đối chiếu.

## Hiện trạng cần xử lý

- `index.html:46-52` nạp đồng thời bảy file CSS, tổng 806.011 byte mã nguồn.
  `landing-reference.css` và `luminous-engine.css` cùng định nghĩa nhiều phần
  của landing; `style.css`, `ui-system.css`, `navigation-reference.css` và
  `luminous-engine.css` cùng định nghĩa app shell và điều hướng. Một lần quét
  selector theo tên ghi nhận khoảng 675 selector có mặt ở nhiều file; đây là
  dấu hiệu chồng lớp, chưa phải danh sách quy tắc được phép xóa.
- `index.html:1433` vẫn chứa màn Kiểm kho/Sản xuất cũ trong `#goods-panel`.
  `goods.js:1495` ngừng đăng ký các sự kiện cũ và `purchases.js:335` thay nội
  dung panel bằng Phiếu mua hàng. `main.js:71-81` chưa có trạng thái tải cho
  `goods-panel`, nên màn cũ có thể hiện trong khi chờ Cloud.
- `index.html:783` ẩn bộ chọn bố cục điều hướng, nhưng
  `js/components/navigation-theme.js:59-79` vẫn khôi phục bố cục dọc từ
  localStorage. `index.html:1033` ẩn thanh tóm tắt Dashboard, nhưng
  `js/components/dashboard.js:1251-1254` vẫn cập nhật các chip bên trong.
- `index.html` có hơn 900 thuộc tính `style=`. Cần phân biệt style trình bày
  đang chặn CSS mới với trạng thái hiển thị do JavaScript điều khiển.
- `DESIGN.md` còn dùng ví dụ Energy/Water và smart home; cần sửa thành mô tả
  giao diện SaaS bán hàng SoVie trước khi coi tài liệu là chuẩn thiết kế.

## Cấu trúc CSS đích

| Lớp | Nội dung sở hữu |
| --- | --- |
| `styles/base.css` | Reset, token, typography, form/button/modal dùng chung và trạng thái hiện/ẩn nền tảng. |
| `styles/landing.css` | Chỉ selector thuộc landing, chuyển động và phần đăng nhập liên quan. |
| `styles/app.css` | App shell, điều hướng, bảng, dashboard và các màn nghiệp vụ; chia section theo module. |
| `styles/print.css` | Quy tắc in hóa đơn, phiếu trả và các biến thể bản in. |

Chỉ giữ một định nghĩa token toàn cục và một nơi sở hữu mỗi thành phần. Giữ
`#landing-page` và `#app-layout` làm ranh giới selector. Tên file đích có thể
được chốt khi chuyển lớp đầu tiên; hợp đồng về quyền sở hữu và thứ tự nạp ở
bảng trên phải được giữ.

## Trình tự thực hiện

### 1. Chốt giao diện chuẩn và lập bản đồ phụ thuộc

- Chụp trạng thái hiện tại của landing, đăng nhập, các panel, menu, form, modal
  và bản in tại 390, 768, 1199, 1200 và 1440 px; lưu cả trạng thái mở, lỗi,
  loading và không có dữ liệu. Đối chiếu vai trò platform, admin, accounting,
  sale ở các màn có phân quyền.
- Cập nhật `DESIGN.md` theo sản phẩm SoVie; xác định màu, chữ, icon Lucide,
  điều hướng ngang và hành vi mobile. Quyết định giữ hay gỡ `ref-orb` và
  `btn-shimmer`: HTML vẫn có các phần này, trong khi `luminous-engine.css:140-154`
  đang ẩn chúng.
- Lập bảng cho mỗi selector/DOM hook: đang dùng bởi HTML tĩnh, template JS,
  trạng thái runtime, in ấn, hoặc đã bỏ. Dùng computed styles và CSS coverage
  trên các màn thật; tên class không xuất hiện trong HTML chưa đủ để kết luận
  là dư vì nhiều module tạo markup bằng JavaScript.

**Xong khi:** Có bộ ảnh chuẩn và danh sách selector/DOM hook cần giữ hoặc chuyển.

### 2. Gỡ màn Kiểm kho/Sản xuất cũ khỏi Phiếu mua hàng

- Thay nội dung tĩnh `#goods-panel` trong `index.html` bằng mount/skeleton của
  Phiếu mua hàng; giữ nguyên ID panel và `data-target` điều hướng. Bổ sung
  trạng thái loading cho `goods-panel` trong `main.js` để không lộ màn cũ khi
  Cloud phản hồi chậm.
- Rút `js/components/goods.js` về adapter gọi `renderPurchasesPanel`; bỏ phần
  listener nằm sau `return` trong `setupGoodsPanel()` và các helper UI chỉ dùng
  cho Kiểm kho/Sản xuất cũ. Gỡ modal Excel nguyên liệu/BTP và các modal nguyên
  liệu, BTP, công thức, tồn kho tại `index.html:4478`, `4542`, `5160-5355` sau
  khi đối chiếu toàn bộ ID tham chiếu.
- Bỏ `setupGoodsSurfaces()` và selector trang trí tab kho cũ trong
  `js/components/module-filter-layout.js:1012`; giữ các cấu phần phục vụ Phiếu
  mua hàng. Cập nhật bài kiểm tra phạm vi `active-scope-no-inventory.test.mjs`.

**Xong khi:** Tab Phiếu mua hàng chỉ có loading hoặc UI mua hàng ở mọi thời
điểm, kể cả khi Cloud chậm hoặc lỗi.

### 3. Gỡ các điều khiển bị ẩn nhưng còn chạy

- Nếu điều hướng ngang là chuẩn duy nhất, bỏ `#nav-layout-settings`, listener
  `.nav-layout-option`, nhánh `vertical` và CSS tương ứng. Chuyển giá trị
  `sovie_nav_layout_v2` đã lưu sang `horizontal` một lần rồi bỏ khóa cũ. Rà
  `sovie_nav_color`/`vieone_nav_color` và các biến màu điều hướng trước khi bỏ
  code tùy biến màu không còn nút điều khiển. Cập nhật harness/test navigation.
- Gỡ `.dashboard-compact-bar` và các chip luôn ẩn. Chuyển thông tin cần hiển
  thị sang badge/nút lọc trong header, rồi bỏ các cập nhật DOM cũ tại
  `dashboard.js:1251-1254` và selector CSS liên quan. Cập nhật bài kiểm tra
  `module-filter-layout.test.mjs` theo giao diện thực tế.
- `customer-legacy-manager-filter` vẫn được `users.js` và
  `module-filter-layout.js` dùng. Chuyển tham chiếu sang bộ lọc hiện hành trước
  khi đổi tên hoặc gỡ class. Không coi modal đóng, menu ẩn và KPI/Payroll được
  hoãn là DOM dư chỉ vì chúng bắt đầu ở trạng thái ẩn.

**Xong khi:** Không còn UI ẩn cứng có listener hoặc dữ liệu được cập nhật vô ích;
giá trị localStorage cũ không thể phục hồi layout đã bỏ.

### 4. Hợp nhất CSS landing, điều hướng và từng màn ứng dụng

1. **Landing:** Chuyển motion/sentinel còn dùng từ `landing.css:936-1288` và
   login help từ `landing-premium.css:959-992` sang lớp landing/auth mới. Gom
   giao diện `ref-*` hiện hành từ `landing-reference.css` với phần marketing
   đang bị định nghĩa lại tại `luminous-engine.css:1069-2382`. Sau khi ảnh và
   hành vi khớp, tháo link rồi xóa `landing.css` và `landing-premium.css`.
2. **Điều hướng:** Dùng một hệ icon Lucide. `ui-system.css:7895-7906` đang ẩn
   SVG để dùng glyph Material, `navigation-reference.css:58-64` lại bật SVG.
   Chuyển trạng thái nav, submenu, mobile và role vào lớp app mới; xóa bản sao
   ở `navigation-reference.css` và `luminous-engine.css` trước khi tháo link.
3. **App:** Hợp nhất token đang lặp ở `style.css:1094`, `ui-system.css:8` và
   `luminous-engine.css:10`. Chuyển từng panel một: dashboard, bảng dữ liệu,
   khách hàng, đơn hàng, lịch sử, sổ quỹ, mua hàng, cấu hình. Giữ quy tắc hiện/
   ẩn panel (`style.css:1591-1604`), form (`:1700-1719`), modal (`:2018-2036`)
   và CSS phân quyền động tại `js/components/users.js:1020-1054` cho đến khi có
   bản thay thế tương đương.
4. **In:** Chuyển quy tắc ở `style.css:4421-4590` và phần reset in của
   `luminous-engine.css:5862+` sang lớp in; giữ template và trạng thái
   `body.printing-return` khi kiểm tra hóa đơn và phiếu trả.
5. **Inline style:** Khi chuyển từng thành phần, đưa style trình bày cố định
   từ HTML/JS template sang class mới. Giữ trạng thái động bằng `hidden`, class
   hoặc thuộc tính trạng thái rõ ràng thay cho `display` cứng nơi phù hợp.

**Xong khi:** Mỗi màn lấy hình thức từ một lớp CSS có chủ sở hữu; không cần
chuỗi override và `!important` để thắng phiên bản giao diện trước.

### 5. Xóa file cũ và cập nhật hợp đồng build

- Tháo các link CSS cũ khỏi `index.html` sau từng phần đã chuyển, rồi xóa file
  không còn selector đang dùng. `style.css`, `ui-system.css`,
  `landing-reference.css` và `luminous-engine.css` chỉ được xóa toàn bộ khi
  phần chức năng, responsive và in của chúng đã chuyển xong.
- Cập nhật đồng thời `scripts/project-files.mjs` (`publicFiles` và
  `immutablePublicFiles`), đường dẫn `?v=` trong HTML, và các harness đang nạp
  CSS cũ. `scripts/build-static.mjs` lấy danh sách này để đưa asset vào `dist`
  và sinh cache headers.
- Sửa các bài kiểm tra hiện phụ thuộc tên file hoặc chuỗi CSS cũ thành kiểm
  tra hành vi/markup mới ở các màn có thay đổi. Kiểm tra không còn import,
  selector hay URL trỏ tới file đã xóa.

**Xong khi:** Bản build chỉ chứa CSS đích; số byte CSS nguồn và CSS tải xuống
thấp hơn mốc 806.011 byte, không còn lớp giao diện cũ được nạp cùng giao diện
mới.

## Kiểm tra nghiệm thu theo từng phần

- So sánh ảnh trước/sau ở các kích thước và vai trò nêu trên; tập trung vào
  điều hướng, bảng, bộ lọc, modal, form, trạng thái lỗi và loading, tràn ngang
  trên mobile.
- Thực hiện các luồng đăng nhập, chuyển panel, lọc Dashboard, tạo/chỉnh đơn,
  xem lịch sử, thu chi, Phiếu mua hàng, mở menu, đổi workspace và đăng xuất.
- Kiểm tra bản in A4 của retail, agent, processing, warehouse và phiếu trả;
  giữ phân biệt `body.printing-return`.
- Chạy kiểm tra cấu trúc, build và các bài kiểm tra có liên quan sau từng phần
  chuyển. Đối chiếu CSS coverage và kích thước asset sau phần cuối.

Mỗi phần được hoàn thành thành một thay đổi nhỏ, có thể xem diff và quay lại
riêng. Workspace đang có nhiều thay đổi chưa commit ở HTML/CSS/JS; khi triển
khai phải giữ nguyên các thay đổi này và rà diff trước khi sửa cùng khu vực.

## Trạng thái triển khai ngày 2026-09-24

| Phần | Trạng thái | Kết quả |
| --- | --- | --- |
| 1. Giao diện chuẩn và phụ thuộc | Một phần | Đã cập nhật `DESIGN.md` theo SoVie, điều hướng ngang, Lucide và hành vi responsive. Đã gỡ markup/CSS `ref-orb` và vòng quỹ đạo vì chúng bị ẩn bằng `display:none`; đã bỏ `btn-shimmer`. Chưa lập bộ ảnh đối chiếu đầy đủ theo 5 kích thước, vai trò và trạng thái. |
| 2. Kho/Sản xuất cũ | Hoàn tất | `#goods-panel` có skeleton Phiếu mua hàng; `goods.js` là adapter; modal và markup Kiểm kho/Sản xuất cũ đã bỏ; lỗi tải Cloud không để skeleton treo. |
| 3. Điều khiển ẩn | Hoàn tất | Đã bỏ cài đặt bố cục điều hướng và cập nhật chip Dashboard bị ẩn; xóa khóa localStorage cũ; đổi tên hook bộ lọc khách hàng sang tên đang dùng. |
| 4. Hợp nhất CSS | Đã hợp nhất file, còn chuẩn hóa sâu | `index.html` nạp `styles/base.css`, `styles/app.css`, `styles/landing.css`, `styles/print.css`; landing được khoanh vùng; quy tắc in được tách; glyph Material, hiệu ứng shimmer và các quỹ đạo bị ẩn đã bỏ. Ba khối token `:root` đã nhập thành một chủ sở hữu ở `base.css`; template Phiếu mua hàng không còn style inline. Tổng CSS hiện 777.795 byte so với 806.011 byte ban đầu. Chưa chuyển hết style inline còn lại và chưa rà/giải quyết mọi chuỗi override theo từng panel bằng CSS coverage. |
| 5. Build và harness | Hoàn tất | Build hỗ trợ thư mục asset lồng nhau; danh sách asset và harness đã chuyển sang bốn stylesheet mới; bảy file CSS cũ đã xóa. |

### Kết quả kiểm tra

- `npm run verify:structure`: đạt; 54 module JS có thể truy cập, 12 file gốc được triển khai, 101 migration theo thứ tự.
- `npm run build`: đạt.
- 47 bài kiểm tra mục tiêu về giao diện, cấu trúc, Phiếu mua hàng và các luồng liên quan: đạt.
- Bộ test đầy đủ: 557 đạt, 2 lỗi không thuộc phần giao diện này. `cloud-read-health.test.mjs` còn kiểm tra cách triển khai cũ nằm trực tiếp trong `supabase.js`, trong khi logic hiện được ủy quyền cho `js/domain/cloud-read-health.js`; `mobile-dashboard-salesperson.test.mjs` cần thư mục sibling `D:\Desktop\mobile-app` hiện không có trong workspace.
- Đã xem nhanh landing ở chế độ responsive và mở Phiếu mua hàng bằng fixture kế toán. Đã đối chiếu Phiếu mua hàng ở 390, 768, 1199, 1200 và 1440 px; trang không tràn ngang, bảng rộng cuộn bên trong vùng dữ liệu. Chưa nghiệm thu đủ ma trận các màn hình/luồng khác.

### Việc còn lại trước khi đánh dấu nghiệm thu toàn bộ

1. Chụp và so sánh đầy đủ landing, đăng nhập, các panel, menu, modal và bản in ở 390, 768, 1199, 1200, 1440 px theo vai trò và trạng thái trong mục 1.
2. Tiếp tục chuyển style trình bày cố định trong HTML/JS template còn lại sang class có tên rõ nghĩa, giữ các style trạng thái do dữ liệu/JS điều khiển.
3. Dùng CSS coverage theo màn hình để loại các rule còn sót và xử lý các override xung đột theo từng panel; không xóa rule chỉ dựa trên việc tên class không xuất hiện trong HTML tĩnh.
4. Chạy lại toàn bộ kiểm tra sau các bước trên và cập nhật số byte CSS cuối.
