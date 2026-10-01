# Sovie.vn SaaS staging readiness

Ngày kiểm định mã nguồn: 2026-08-29  
Supabase staging: `mqxqswwssmemkimnolfu`  
Production: không tác động

## Phạm vi xác nhận

Kết quả bên dưới là bản ghi kiểm định tại ngày nêu trên; khi đó staging được xác
nhận đến migration `0097`. Mã nguồn hiện có các migration đến `0101`, nhưng tài
liệu này không xác nhận `0098`–`0101` đã được áp dụng. Trước lần triển khai kế
tiếp, đối chiếu `public.schema_migrations` trên đúng project staging và cập nhật
kết quả kiểm định từ database; không suy ra trạng thái staging từ tên file trong
repository.

## Kết quả đã đạt

- Chuỗi migration trong mã nguồn và staging đã đồng bộ đến `0097` (42 migration từ `0056` đến `0097`). Migration quản lý `align_workspace_domains_to_sovie_vn` đã áp dụng ngày 2026-08-29; audit sau migration xác nhận cả 3 workspace dùng `*.sovie.vn`, không còn hostname `*.sovie.io.vn` và không có custom-domain xung đột hậu tố nội bộ.
- Console quản trị khách hàng cấp nền tảng đã tách khỏi quyền tenant; tài khoản
  `tvnhat10083@gmail.com` giữ riêng role `platform_owner`, không có tenant
  membership; `tranvnhat86@gmail.com` chỉ còn là Owner doanh nghiệp test.
- Luồng tạo khách hàng cấp nền tảng đã triển khai bằng RPC `0081` và Edge
  Function `platform-create-customer`; endpoint từ chối phiên không hợp lệ với
  HTTP 401, sự kiện provisioning không thể đọc trực tiếp từ browser.
- Console đã có luồng đổi gói, gia hạn trial, tạm khóa, kích hoạt lại và chấm
  dứt có xác nhận; mọi thay đổi đi qua RPC `0082` và được audit kép.
- Bảng giá thương mại tháng/năm và quota có thể quản lý từ console qua RPC
  `0083`. Staging hiện có giá Starter 100.000/900.000, Pro
  150.000/1.300.000 và Business 500.000/5.000.000 đồng theo tháng/năm;
  Pro và Business vẫn `is_public=false` cho tới khi phê duyệt thương mại.
- Adapter MoMo, tax policy tách riêng VAT và hai Edge Function
  `momo-create-checkout`/`momo-ipn` đã triển khai trên staging. IPN không yêu
  cầu JWT nhưng tự xác minh HMAC. Cấu hình database hiện là MoMo, VAT 8% theo
  chế độ giá chưa gồm thuế, đã có thông tin đơn vị phát hành và
  `billing_enabled=true`; trạng thái secret/URL và giao dịch sandbox vẫn phải
  được nghiệm thu riêng trước khi coi là sẵn sàng thương mại.
- Gói chi nhánh/kho và quota: SQL 9/9.
- Backup tenant có inventory/manifest: SQL 5/5.
- Soft-archive organization: SQL 7/7.
- `organization_id NOT NULL`: 33 bảng nghiệp vụ, schema test 2/2.
- Release readiness audit: 6/6; không có dòng nghiệp vụ thiếu tenant, RPC
  service không callable từ browser, Pro/Business vẫn chưa public.
- Commercial launch database audit: 11/11; bao gồm migration 0056–0097,
  tenant boundary, mobile read-model, domain `sovie.vn`, billing database và
  quyền RPC service-only.
- Regression mã nguồn: 502/502 và static build thành công tại lần kiểm định
  2026-08-29.
- Hành trình khách hàng mới có cổng `npm run test:journey`: một mật khẩu cá nhân, tự nhận lời mời, tạo/chuyển workspace, khôi phục mật khẩu và checklist 5 bước trên dashboard.
- Giao diện dùng chung module identity `20260817-saas-platform-v6`.
- Supabase Security Advisor: 0 error; lần quét sau migration có 4 info cho bảng
  service-only đã khóa browser, 106 warning chung về hàm `SECURITY DEFINER`
  callable bởi signed-in users và 1 warning chưa bật leaked-password
  protection. Các RPC nhạy cảm đã được kiểm tra quyền riêng bằng SQL, nhưng
  danh sách function vẫn cần allowlist/review và Auth protection cần bật sau
  khi nâng Supabase Pro trước production.

`audit_logs` còn 1.012 dòng platform/legacy không có tenant. Đây là ngoại lệ
bootstrap có chủ đích, không thuộc 33 bảng dữ liệu nghiệp vụ và không được đưa
vào tenant export. `activity_logs` không có dòng null tenant.

## Cổng còn phải hoàn thành trước commercial launch

1. Phê duyệt chính thức bảng giá chưa gồm VAT trên staging; Pro và Business
   vẫn `is_public=false` nên chưa được công bố thương mại.
2. Xác nhận với kế toán phần mềm/dịch vụ thuộc diện chịu VAT hay không chịu VAT;
   nếu chịu VAT thì nhập đúng thuế suất và thông tin đơn vị xuất hóa đơn.
3. Cấu hình MoMo sandbox secrets, URL trả về HTTPS và IPN URL; chạy giao dịch
   sandbox thành công, thất bại và callback lặp trước khi bật billing.
4. Cấu hình bốn biến Cloudflare cho Custom Hostname/SSL và chạy thử với domain test.
5. Nâng Supabase khỏi Free để có scheduled backups (và PITR nếu yêu cầu), tạo
   full dump rồi diễn tập restore vào một project staging mới, rỗng.
6. Review/allowlist toàn bộ Security Advisor warnings và chạy lại linter.
7. Kiểm thử nghiệm thu bằng tài khoản Owner/Admin/Accounting/Sale trên bản host
   staging trước khi lập kế hoạch migration production riêng.
8. Cấu hình custom SMTP và Redirect URLs cho `https://sovie.vn` cùng các hostname
   staging trước khi nghiệm thu email mời và khôi phục mật khẩu. Không dùng giới
   hạn gửi thử mặc định của Supabase cho production.

Không cổng nào ở trên được tự động vượt qua bằng secret giả, giá giả hoặc thao
tác trực tiếp lên production.

## Verification update — 2026-09-28

This section records the latest direct staging work. It supplements the
2026-08-29 audit above; it does not replace that historical snapshot.

### Environment and database state

- The browser app was served from the local workspace at
  `http://127.0.0.1:3000/`; the repository was on branch
  `codex/remaining-sovie-fixes`, starting at commit `60005e2`. The working
  tree already contained changes across several earlier tasks; no commit or
  push was made during this verification.
- Supabase project: `mqxqswwssmemkimnolfu`. The active organization was the
  legacy paint workspace `00000000-0000-4000-8000-000000000001`. The signed-in
  membership role was `owner`; the legacy profile role was `admin`. No second
  workspace or second role account was available in this session.
- A read-only query of `public.schema_migrations` confirmed `0099`, `0102`,
  and `0103` are registered as applied. `0104` is absent. This checks the
  registry only; it does not prove deployed function and trigger definitions
  are byte-for-byte equivalent to the repository migrations.
- The pre-test history baseline recorded for this workspace was 429 orders:
  295 effective orders and 134 cancelled orders. With the default history
  status filters, the screen after QA showed 295 effective orders and 6
  drafts (301 rows); cancelled orders are excluded by those filters.

### Direct save-and-reload results

| Area | Result | Evidence and limits |
|---|---|---|
| Product/SKU | Passed | Created a QA product family with two service SKUs, including a no-brand SKU and optional package details; edited one SKU and reloaded the catalog. The app retained service kind, hour unit, empty brand, and the edited package descriptor. |
| Customer | Passed | Created and edited a QA customer with optional contact/location fields empty, an assigned brand and Bảng giá 04. Reload retained the fields and price-list assignment; debt remained `0`. |
| Price list | Partial pass | Added an explicit `12,345` price for a QA service SKU in Bảng giá 04; the UI and a read-only Cloud query showed the same value after reload. Inherited price, intentional zero, and missing-price cases were not exercised. |
| Draft order | Passed after code fix | The first reload exposed a defect: the history range loader fetched `orders` but omitted `draft_orders`. The client now loads both tables and replaces stale cached drafts after a successful Cloud read. After a full browser reload, draft `NH-20260928-0CB183` appeared in history; its detail and edit form retained customer QA, SKU `B-H2-LON`, Bảng giá 04, unit price and total `341,300`, and zero paid. A regression test covers this load path. The draft was not finalized. |
| Dashboard, roles, second workspace, >1,000-row pagination, print/export, responsive layouts | Not verified | This run did not compare all dashboard totals, test Sale/Accounting sessions, access a second industry workspace, exercise a dataset over 1,000 rows, open printed/exported files, or resize the browser to the planned viewports. |
| Payments, debt collection, cashbook transactions, supplier purchases/payments, sales returns, cancellation | Not exercised | These are financial postings or reversals. No payment, finalized sale, purchase, cashbook entry, return, or cancellation was submitted, so their accounting effects remain unverified. |

### QA records left in staging

The following records were created through the app with QA identifiers and are
still present so they can be inspected or cleaned up through normal app flows:

- Product family `QA-UAT-20260928` with SKU codes
  `QA-UAT-20260928-01` and `QA-UAT-20260928-02`.
- Customer `QA-UAT-CUS-20260928`.
- The `12,345` override for `QA-UAT-20260928-02` in Bảng giá 04.
- Draft order `DRAFT-0cb18369-8b80-48a4-b647-2c2b32765ae5` (display code
  `NH-20260928-0CB183`). It has not changed customer debt or created a payment.

No staging database SQL was modified directly during these checks. Migration
`0104` still needs to be applied through the normal migration process before
its server-side order-policy enforcement can be treated as active.

### Release verification

After the code fix and regression test, `npm run release:check` passed: structure
verification found 54 reachable JavaScript modules, 12 deployed root files and
104 ordered migrations; migration verification passed; the test suite passed
585/585; and the static build completed. `git diff --check` reported no
whitespace errors; it only reported the repository's CRLF-to-LF normalization
warnings for `docs/SAAS_STAGING_READINESS.md` and `index.html`.

Print verification remains open: choosing the QA invoice type caused the
in-app browser to show a `127.0.0.1:3000` connection error page, although the
local port was still listening. No physical print was submitted. Excel export
was triggered for the single selected QA draft, and the app reported that one
order was exported. The workbook was not opened or inspected, so its contents
remain unverified.

## Verification update — 2026-09-30

This is the newest read-only Cloud verification and local release check. It supersedes the 2026-09-28 statement above that `0104` was absent; that statement remains an accurate historical snapshot for that earlier session.

### Source and Cloud baseline

- Local branch: `codex/remaining-sovie-fixes`; starting commit: `60005e2`. The working tree contains changes from earlier tasks as well as this pass. No commit, push, deploy, migration, or direct database write was made.
- Supabase staging project: `mqxqswwssmemkimnolfu`.
- Read-only query of `public.schema_migrations` confirmed `0099`, `0102`, `0103`, and `0104` are registered, with their expected descriptions.
- Read-only inspection confirmed `validate_customer_order_brand_scope()` references `products.item_kind`. Triggers `p1_order_assigned_brand_scope` and `p1_draft_order_assigned_brand_scope` run before INSERT or changes to items, customer, or organization on their respective tables.
- The `sales.brand_restriction_enabled` configuration was `true` for the legacy painting workspace and `false` for each of four other workspaces. This confirms distinct stored policies; it does not substitute for logging in and testing each workspace and role.

### Changes and automated verification

- The client policy now recognizes both `itemKind` and `item_kind`, including values nested in a catalog product. The SKU search reports when a matching item is hidden by the customer's assigned-brand restriction without making the restricted SKU selectable.
- Supplier loading now retains a full directory for purchase-history lookup while exposing only active suppliers as new-purchase choices. Tenant reset clears both collections. A regression test covers inactive suppliers and purchase snapshots.
- The staging E2E script now derives the order company/workspace scope from the Sale profile rather than hard-coding `ABS_NORTH`, and checks that its three test accounts belong to the same workspace. The script parsed successfully; it was not run because it requires credentials for separate Admin, Accounting, and Sale accounts and creates financial entries before reversing them.
- `npm run release:check` passed on this source tree: 55 reachable JavaScript modules, 12 deployed root files, 104 ordered migrations, and 587/587 tests; the static build completed. SHA-256 of built `dist/index.html`: `36852C683D0851E74B0E807524EF3206BEE365DFF9342AC70A955CDB6A41B76A`.
- Targeted policy/supplier regression tests passed 11/11. `git diff --check` found no whitespace errors; Git emitted its existing line-ending normalization warning for `index.html`.

### Not yet accepted

- Browser-driven testing of the local UI could not proceed: the browser security policy rejected access to `http://127.0.0.1:3000/`. The local HTTP server answered successfully from the shell, but no browser workaround was attempted. Search feedback, inactive-supplier history, responsive filters, and print/export therefore still need visual confirmation.
- No UI save/reload or cross-workspace/role run was completed in this pass. Dashboard reconciliation, 1,000+ row comparison against Cloud, Excel workbook inspection, and A4 print preview remain open.
- No finalized order, payment, purchase, return, cashbook transaction, or reversal was submitted during this pass. Their Cloud balances and audit trails remain unverified. The app's save/reload/reversal UAT must be completed using the authorized staging accounts before this system can be marked ready.

No commercial-launch decision is implied by the passing code checks. Backup and restore, Security Advisor, sandbox billing, email delivery, and deployment configuration remain separate operational gates.

### Read-only Cloud aggregate cross-check — 2026-09-30

For legacy workspace `00000000-0000-4000-8000-000000000001`, counts were: customers 1,639 (1,639 distinct IDs); products 1,016 (958 active); orders 429 (294 settled, 1 partially returned, 134 cancelled); suppliers 2 (1 active); purchases 1. That purchase references an inactive supplier. The QA customer has an assigned brand; active SKU `QA-UAT-20260930-SVC-01` has catalog kind `service` and no brand. These are Cloud records, but were only inspected read-only and were not used in the browser UI this pass.

### Cloud RPC access boundary — 2026-09-30

Read-only inspection of `rpc_set_sales_brand_restriction(boolean)` confirmed its body contains the workspace role guard and activity-log write, `authenticated` has EXECUTE, and `anon` does not. This verifies the deployed RPC definition's static access boundary; runtime Owner/Admin versus Sale/Accounting denial still requires sessions for those roles.

## Brand catalog and issuer update — 2026-10-01 — local only

- Migration `0105_optional_workspace_brands_and_invoice_issuer.sql` is prepared locally after `0104`. The read-only Cloud snapshot above showed `0104` as the latest applied version; this pass did not apply `0105` or write business data to Supabase.
- The change makes product brand optional, separates catalog visibility from the optional assigned-brand sales restriction, preserves brand rows when their metadata is edited, and prevents deletion while products or customers reference the brand.
- Issuer details are now configured per company/branch and copied onto new orders and drafts. Historical printing continues to prefer a saved snapshot and uses the legacy brand profile only in the explicitly identified legacy paint workspace.
- Dashboard and client company filters attribute revenue to the order's transaction company. The old brand-to-company fallback remains only for legacy client data that has no transaction company.
- `npm run release:check` passed with 596/596 tests and the static build. This is local verification only: apply `0105` to staging, then confirm the Owner/Admin settings UI, transaction-company Dashboard totals, product edits with an empty brand, and invoice print snapshots in the actual workspace before treating Cloud behavior as verified.
