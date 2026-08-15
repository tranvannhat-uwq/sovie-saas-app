-- ====================================================================
-- SQL Script nâng cấp bảo mật và cấu hình CSDL Supabase cho ứng dụng WebLendon
-- Sao chép toàn bộ mã này và chạy trong SQL Editor của Supabase để nâng cấp.
-- ====================================================================

-- 1. TẠO CÁC BẢNG DỮ LIỆU NẾU CHƯA CÓ

-- Bảng khách hàng (customers)
CREATE TABLE IF NOT EXISTS customers (
    id text PRIMARY KEY,
    code text UNIQUE NOT NULL,
    name text NOT NULL,
    phone text,
    address text,
    assigned_brand text DEFAULT 'Tất cả',
    brand_discounts jsonb DEFAULT '{}'::jsonb,
    shipping_support boolean DEFAULT false,
    debt numeric DEFAULT 0,
    total_transaction numeric DEFAULT 0,
    notes text,
    pricelist_id text,
    managed_by text,
    debt_history jsonb DEFAULT '[]'::jsonb,
    created_at timestamptz DEFAULT now()
);

-- Bảng sản phẩm (products)
CREATE TABLE IF NOT EXISTS products (
    code text NOT NULL,
    brand text NOT NULL DEFAULT 'Nano10*',
    name text NOT NULL,
    price numeric DEFAULT 0,
    price_thung numeric DEFAULT 0,
    price_lon numeric DEFAULT 0,
    price_hop numeric DEFAULT 0,
    price_bao numeric DEFAULT 0,
    price_tui numeric DEFAULT 0,
    weight_thung text DEFAULT '',
    weight_bao text DEFAULT '',
    weight_lon text DEFAULT '',
    weight_hop text DEFAULT '',
    weight_tui text DEFAULT '',
    created_at timestamptz DEFAULT now(),
    CONSTRAINT products_pk PRIMARY KEY (code, brand)
);

-- Bảng hóa đơn (orders)
CREATE TABLE IF NOT EXISTS orders (
    id text PRIMARY KEY,
    customer_id text,
    customer_name text NOT NULL,
    notes text,
    items jsonb NOT NULL,
    total_market numeric DEFAULT 0,
    total_discount numeric DEFAULT 0,
    shipping_support boolean DEFAULT false,
    shipping_discount numeric DEFAULT 0,
    total_payable numeric DEFAULT 0,
    pricelist_id text,
    created_by text,
    status text DEFAULT 'settled',
    created_at timestamptz DEFAULT now()
);

-- Bảng đơn hàng nháp (draft_orders)
CREATE TABLE IF NOT EXISTS draft_orders (
    id text PRIMARY KEY,
    customer_id text,
    customer_name text NOT NULL,
    notes text,
    items jsonb NOT NULL,
    total_market numeric DEFAULT 0,
    total_discount numeric DEFAULT 0,
    shipping_support boolean DEFAULT false,
    shipping_discount numeric DEFAULT 0,
    total_payable numeric DEFAULT 0,
    pricelist_id text,
    created_by text,
    status text DEFAULT 'draft',
    created_at timestamptz DEFAULT now()
);

-- Bảng bảng giá (pricelists)
CREATE TABLE IF NOT EXISTS pricelists (
    id text PRIMARY KEY,
    name text NOT NULL,
    brand_discounts jsonb DEFAULT '{}'::jsonb,
    created_at timestamptz DEFAULT now()
);

-- Bảng người dùng nội bộ (users)
CREATE TABLE IF NOT EXISTS users (
    id text PRIMARY KEY,
    username text NOT NULL UNIQUE,
    password text,
    display_name text NOT NULL,
    role text DEFAULT 'sale',
    created_at timestamptz DEFAULT now()
);


-- 2. ĐẢM BẢO CÁC CỘT ĐÃ TỒN TẠI (NẾU BẢNG ĐÃ ĐƯỢC TẠO TỪ TRƯỚC)

-- Cập nhật bảng customers
ALTER TABLE IF EXISTS customers ADD COLUMN IF NOT EXISTS assigned_brand text DEFAULT 'Tất cả';
ALTER TABLE IF EXISTS customers ADD COLUMN IF NOT EXISTS brand_discounts jsonb DEFAULT '{}'::jsonb;
ALTER TABLE IF EXISTS customers ADD COLUMN IF NOT EXISTS shipping_support boolean DEFAULT false;
ALTER TABLE IF EXISTS customers ADD COLUMN IF NOT EXISTS debt numeric DEFAULT 0;
ALTER TABLE IF EXISTS customers ADD COLUMN IF NOT EXISTS total_transaction numeric DEFAULT 0;
ALTER TABLE IF EXISTS customers ADD COLUMN IF NOT EXISTS pricelist_id text;
ALTER TABLE IF EXISTS customers ADD COLUMN IF NOT EXISTS managed_by text;
ALTER TABLE IF EXISTS customers ADD COLUMN IF NOT EXISTS debt_history jsonb DEFAULT '[]'::jsonb;
ALTER TABLE IF EXISTS customers ADD COLUMN IF NOT EXISTS phone2 text;
ALTER TABLE IF EXISTS customers ADD COLUMN IF NOT EXISTS email text;
ALTER TABLE IF EXISTS customers ADD COLUMN IF NOT EXISTS facebook text;
ALTER TABLE IF EXISTS customers ADD COLUMN IF NOT EXISTS birthday text;
ALTER TABLE IF EXISTS customers ADD COLUMN IF NOT EXISTS gender text;
ALTER TABLE IF EXISTS customers ADD COLUMN IF NOT EXISTS avatar_url text;
ALTER TABLE IF EXISTS customers ADD COLUMN IF NOT EXISTS province text;
ALTER TABLE IF EXISTS customers ADD COLUMN IF NOT EXISTS ward text;
ALTER TABLE IF EXISTS customers ADD COLUMN IF NOT EXISTS customer_group_id text;
ALTER TABLE IF EXISTS customers ADD COLUMN IF NOT EXISTS company_name text;
ALTER TABLE IF EXISTS customers ADD COLUMN IF NOT EXISTS tax_code text;
ALTER TABLE IF EXISTS customers ADD COLUMN IF NOT EXISTS invoice_address text;
ALTER TABLE IF EXISTS customers ADD COLUMN IF NOT EXISTS status text DEFAULT 'active';
ALTER TABLE IF EXISTS customers ADD COLUMN IF NOT EXISTS created_by text;
ALTER TABLE IF EXISTS customers ADD COLUMN IF NOT EXISTS total_return numeric DEFAULT 0;
ALTER TABLE IF EXISTS customers ADD COLUMN IF NOT EXISTS net_revenue numeric DEFAULT 0;
ALTER TABLE IF EXISTS customers ADD COLUMN IF NOT EXISTS last_order_at timestamptz;
ALTER TABLE IF EXISTS customers ADD COLUMN IF NOT EXISTS last_payment_at timestamptz;
ALTER TABLE IF EXISTS customers ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();
ALTER TABLE IF EXISTS customers ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

-- Cập nhật bảng products
ALTER TABLE IF EXISTS products ADD COLUMN IF NOT EXISTS brand text DEFAULT 'Nano10*';
ALTER TABLE IF EXISTS products ADD COLUMN IF NOT EXISTS price_thung numeric DEFAULT 0;
ALTER TABLE IF EXISTS products ADD COLUMN IF NOT EXISTS price_lon numeric DEFAULT 0;
ALTER TABLE IF EXISTS products ADD COLUMN IF NOT EXISTS price_hop numeric DEFAULT 0;
ALTER TABLE IF EXISTS products ADD COLUMN IF NOT EXISTS price_bao numeric DEFAULT 0;
ALTER TABLE IF EXISTS products ADD COLUMN IF NOT EXISTS price_tui numeric DEFAULT 0;
ALTER TABLE IF EXISTS products ADD COLUMN IF NOT EXISTS weight_thung text DEFAULT '';
ALTER TABLE IF EXISTS products ADD COLUMN IF NOT EXISTS weight_bao text DEFAULT '';
ALTER TABLE IF EXISTS products ADD COLUMN IF NOT EXISTS weight_lon text DEFAULT '';
ALTER TABLE IF EXISTS products ADD COLUMN IF NOT EXISTS weight_hop text DEFAULT '';
ALTER TABLE IF EXISTS products ADD COLUMN IF NOT EXISTS weight_tui text DEFAULT '';

-- Bảng công ty (companies)
CREATE TABLE IF NOT EXISTS companies (
    id text PRIMARY KEY,
    code text UNIQUE NOT NULL,
    name text NOT NULL,
    address text DEFAULT '',
    status text DEFAULT 'active',
    created_at timestamptz DEFAULT now()
);

-- Cập nhật bảng users
ALTER TABLE IF EXISTS users ADD COLUMN IF NOT EXISTS company_id text DEFAULT 'ABS_NORTH';
ALTER TABLE IF EXISTS users ADD COLUMN IF NOT EXISTS is_external boolean DEFAULT false;
ALTER TABLE IF EXISTS users ALTER COLUMN password DROP NOT NULL;

-- Cập nhật bảng orders
ALTER TABLE IF EXISTS orders ADD COLUMN IF NOT EXISTS customer_id text;
ALTER TABLE IF EXISTS orders ADD COLUMN IF NOT EXISTS salesperson_id text;
ALTER TABLE IF EXISTS orders ADD COLUMN IF NOT EXISTS customer_manager_id text;
ALTER TABLE IF EXISTS orders ADD COLUMN IF NOT EXISTS company_id text DEFAULT 'ABS_NORTH';
ALTER TABLE IF EXISTS orders ADD COLUMN IF NOT EXISTS revenue_brand_id text;
ALTER TABLE IF EXISTS orders ADD COLUMN IF NOT EXISTS subtotal numeric DEFAULT 0;
ALTER TABLE IF EXISTS orders ADD COLUMN IF NOT EXISTS discount_value numeric DEFAULT 0;
ALTER TABLE IF EXISTS orders ADD COLUMN IF NOT EXISTS discount_type text DEFAULT 'amount';
ALTER TABLE IF EXISTS orders ADD COLUMN IF NOT EXISTS discount_amount numeric DEFAULT 0;
ALTER TABLE IF EXISTS orders ADD COLUMN IF NOT EXISTS other_fee_value numeric DEFAULT 0;
ALTER TABLE IF EXISTS orders ADD COLUMN IF NOT EXISTS other_fee_type text DEFAULT 'amount';
ALTER TABLE IF EXISTS orders ADD COLUMN IF NOT EXISTS other_fee_amount numeric DEFAULT 0;
ALTER TABLE IF EXISTS orders ADD COLUMN IF NOT EXISTS total_amount numeric DEFAULT 0;
ALTER TABLE IF EXISTS orders ADD COLUMN IF NOT EXISTS paid_amount numeric DEFAULT 0;
ALTER TABLE IF EXISTS orders ADD COLUMN IF NOT EXISTS debt_amount numeric DEFAULT 0;
ALTER TABLE IF EXISTS orders ADD COLUMN IF NOT EXISTS returned_amount numeric DEFAULT 0;
ALTER TABLE IF EXISTS orders ADD COLUMN IF NOT EXISTS net_revenue numeric DEFAULT 0;
ALTER TABLE IF EXISTS orders ADD COLUMN IF NOT EXISTS status text DEFAULT 'settled';
ALTER TABLE IF EXISTS orders ADD COLUMN IF NOT EXISTS order_date timestamptz DEFAULT now();
ALTER TABLE IF EXISTS orders ADD COLUMN IF NOT EXISTS confirmed_at timestamptz;
ALTER TABLE IF EXISTS orders ADD COLUMN IF NOT EXISTS pricelist_id text;
ALTER TABLE IF EXISTS orders ADD COLUMN IF NOT EXISTS created_by text;
ALTER TABLE IF EXISTS orders ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();

-- Cập nhật bảng draft_orders
ALTER TABLE IF EXISTS draft_orders ADD COLUMN IF NOT EXISTS customer_id text;
ALTER TABLE IF EXISTS draft_orders ADD COLUMN IF NOT EXISTS company_id text DEFAULT 'ABS_NORTH';
ALTER TABLE IF EXISTS draft_orders ADD COLUMN IF NOT EXISTS subtotal numeric DEFAULT 0;
ALTER TABLE IF EXISTS draft_orders ADD COLUMN IF NOT EXISTS discount_value numeric DEFAULT 0;
ALTER TABLE IF EXISTS draft_orders ADD COLUMN IF NOT EXISTS discount_type text DEFAULT 'amount';
ALTER TABLE IF EXISTS draft_orders ADD COLUMN IF NOT EXISTS discount_amount numeric DEFAULT 0;
ALTER TABLE IF EXISTS draft_orders ADD COLUMN IF NOT EXISTS other_fee_value numeric DEFAULT 0;
ALTER TABLE IF EXISTS draft_orders ADD COLUMN IF NOT EXISTS other_fee_type text DEFAULT 'amount';
ALTER TABLE IF EXISTS draft_orders ADD COLUMN IF NOT EXISTS other_fee_amount numeric DEFAULT 0;
ALTER TABLE IF EXISTS draft_orders ADD COLUMN IF NOT EXISTS status text DEFAULT 'draft';
ALTER TABLE IF EXISTS draft_orders ADD COLUMN IF NOT EXISTS pricelist_id text;
ALTER TABLE IF EXISTS draft_orders ADD COLUMN IF NOT EXISTS created_by text;

-- Cập nhật bảng pricelists
ALTER TABLE IF EXISTS pricelists ADD COLUMN IF NOT EXISTS brand_discounts jsonb DEFAULT '{}'::jsonb;

-- Cập nhật bảng brands
ALTER TABLE IF EXISTS brands ADD COLUMN IF NOT EXISTS id text;
ALTER TABLE IF EXISTS brands ADD COLUMN IF NOT EXISTS company_id text DEFAULT '';

-- Cập nhật bảng products
ALTER TABLE IF EXISTS products ADD COLUMN IF NOT EXISTS brand_id text;

-- Cập nhật bảng customers
ALTER TABLE IF EXISTS customers ADD COLUMN IF NOT EXISTS assigned_brand_id text;

-- Cập nhật bảng raw_materials (Cả 2 khả năng bảng gốc và bảng có tiền tố wl_)
ALTER TABLE IF EXISTS raw_materials ADD COLUMN IF NOT EXISTS import_price numeric DEFAULT 0;
ALTER TABLE IF EXISTS wl_raw_materials ADD COLUMN IF NOT EXISTS import_price numeric DEFAULT 0;


-- 3. KÍCH HOẠT ROW LEVEL SECURITY (RLS) TRÊN TẤT CẢ CÁC BẢNG

ALTER TABLE IF EXISTS users ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS products ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS draft_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS pricelists ENABLE ROW LEVEL SECURITY;



-- 4. TẠO CÁC HÀM HỖ TRỢ PHÂN QUYỀN (SECURITY DEFINER để tránh đệ quy RLS)

-- Hàm so sánh 2 tên người dùng linh hoạt (hỗ trợ so khớp tiền tố không phân biệt tên miền email)
CREATE OR REPLACE FUNCTION public.is_same_user(u1 text, u2 text)
RETURNS boolean AS $$
BEGIN
  RETURN COALESCE(u1, '') = COALESCE(u2, '') 
         OR split_part(COALESCE(u1, ''), '@', 1) = split_part(COALESCE(u2, ''), '@', 1);
END;
$$ LANGUAGE plpgsql;

-- Hàm kiểm tra xem người dùng hiện tại có phải là Admin hay không
CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS boolean SECURITY DEFINER AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM public.users
    WHERE id = auth.uid()::text AND role = 'admin'
  );
END;
$$ LANGUAGE plpgsql;

-- Hàm kiểm tra xem người dùng hiện tại có phải là Admin hoặc Kế toán hay không
CREATE OR REPLACE FUNCTION public.is_admin_or_accounting()
RETURNS boolean SECURITY DEFINER AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM public.users
    WHERE id = auth.uid()::text AND role IN ('admin', 'accounting')
  );
END;
$$ LANGUAGE plpgsql;

-- Hàm lấy username (tên đăng nhập) của người dùng hiện tại từ auth.uid()
CREATE OR REPLACE FUNCTION public.get_current_username()
RETURNS text SECURITY DEFINER AS $$
BEGIN
  RETURN (
    SELECT username FROM public.users
    WHERE id = auth.uid()::text
    LIMIT 1
  );
END;
$$ LANGUAGE plpgsql;


-- 5. ĐỊNH NGHĨA CÁC CHÍNH SÁCH BẢO MẬT (POLICIES) CHO TỪNG BẢNG

-- === BẢNG NGƯỜI DÙNG (users) ===
DROP POLICY IF EXISTS select_users ON users;
DROP POLICY IF EXISTS manage_users ON users;

CREATE POLICY select_users ON users FOR SELECT TO authenticated USING (true);
CREATE POLICY manage_users ON users FOR ALL TO authenticated USING (public.is_admin());

-- === BẢNG SẢN PHẨM (products) ===
DROP POLICY IF EXISTS select_products ON products;
DROP POLICY IF EXISTS manage_products ON products;

CREATE POLICY select_products ON products FOR SELECT TO authenticated USING (true);
CREATE POLICY manage_products ON products FOR ALL TO authenticated USING (public.is_admin_or_accounting());

-- === BẢNG BẢNG GIÁ (pricelists) ===
DROP POLICY IF EXISTS select_pricelists ON pricelists;
DROP POLICY IF EXISTS manage_pricelists ON pricelists;

CREATE POLICY select_pricelists ON pricelists FOR SELECT TO authenticated USING (true);
CREATE POLICY manage_pricelists ON pricelists FOR ALL TO authenticated USING (public.is_admin_or_accounting());

-- === BẢNG KHÁCH HÀNG (customers) ===
DROP POLICY IF EXISTS select_customers ON customers;
DROP POLICY IF EXISTS insert_customers ON customers;
DROP POLICY IF EXISTS update_customers ON customers;
DROP POLICY IF EXISTS delete_customers ON customers;

-- Admin/Kế toán xem tất cả khách hàng; Sale chỉ xem khách hàng mình quản lý
CREATE POLICY select_customers ON customers FOR SELECT TO authenticated USING (
  public.is_admin_or_accounting() OR public.is_same_user(managed_by, public.get_current_username())
);

-- Admin/Kế toán thêm bất kỳ khách hàng nào; Sale chỉ được thêm khách hàng gán cho mình
CREATE POLICY insert_customers ON customers FOR INSERT TO authenticated WITH CHECK (
  public.is_admin_or_accounting() OR public.is_same_user(managed_by, public.get_current_username())
);

-- Admin/Kế toán sửa bất kỳ khách hàng nào; Sale chỉ sửa khách hàng mình quản lý
CREATE POLICY update_customers ON customers FOR UPDATE TO authenticated USING (
  public.is_admin_or_accounting() OR public.is_same_user(managed_by, public.get_current_username())
);

-- Chỉ Admin và Kế toán mới có quyền xóa khách hàng
CREATE POLICY delete_customers ON customers FOR DELETE TO authenticated USING (
  public.is_admin_or_accounting()
);

-- === BẢNG ĐƠN HÀNG ĐÃ CHỐT (orders) ===
DROP POLICY IF EXISTS select_orders ON orders;
DROP POLICY IF EXISTS insert_orders ON orders;
DROP POLICY IF EXISTS update_orders ON orders;
DROP POLICY IF EXISTS delete_orders ON orders;

-- Admin/Kế toán xem tất cả hóa đơn; Sale chỉ xem hóa đơn mình tạo
CREATE POLICY select_orders ON orders FOR SELECT TO authenticated USING (
  public.is_admin_or_accounting() OR public.is_same_user(created_by, public.get_current_username())
);

-- Admin/Kế toán tạo đơn cho bất kỳ ai; Sale chỉ được tạo đơn dưới tên của mình
CREATE POLICY insert_orders ON orders FOR INSERT TO authenticated WITH CHECK (
  public.is_admin_or_accounting() OR public.is_same_user(created_by, public.get_current_username())
);

-- Admin/Kế toán sửa bất kỳ đơn nào; Sale không có quyền sửa đơn đã chốt
CREATE POLICY update_orders ON orders FOR UPDATE TO authenticated USING (
  public.is_admin_or_accounting()
);

-- Chỉ Admin và Kế toán mới có quyền xóa đơn hàng đã chốt
CREATE POLICY delete_orders ON orders FOR DELETE TO authenticated USING (
  public.is_admin_or_accounting()
);

-- === BẢNG ĐƠN HÀNG NHÁP (draft_orders) ===
DROP POLICY IF EXISTS select_draft_orders ON draft_orders;
DROP POLICY IF EXISTS insert_draft_orders ON draft_orders;
DROP POLICY IF EXISTS update_draft_orders ON draft_orders;
DROP POLICY IF EXISTS delete_draft_orders ON draft_orders;

-- Admin/Kế toán xem tất cả đơn nháp; Sale chỉ xem đơn nháp mình tạo
CREATE POLICY select_draft_orders ON draft_orders FOR SELECT TO authenticated USING (
  public.is_admin_or_accounting() OR public.is_same_user(created_by, public.get_current_username())
);

-- Admin/Kế toán tạo đơn nháp; Sale chỉ được tạo đơn nháp dưới tên mình
CREATE POLICY insert_draft_orders ON draft_orders FOR INSERT TO authenticated WITH CHECK (
  public.is_admin_or_accounting() OR public.is_same_user(created_by, public.get_current_username())
);

-- Admin/Kế toán sửa bất kỳ đơn nháp nào; Sale chỉ sửa đơn nháp mình tạo
CREATE POLICY update_draft_orders ON draft_orders FOR UPDATE TO authenticated USING (
  public.is_admin_or_accounting() OR public.is_same_user(created_by, public.get_current_username())
);

-- Admin/Kế toán xóa bất kỳ đơn nháp nào; Sale được quyền xóa đơn nháp mình tạo
CREATE POLICY delete_draft_orders ON draft_orders FOR DELETE TO authenticated USING (
  public.is_admin_or_accounting() OR public.is_same_user(created_by, public.get_current_username())
);


-- 6. TRIGGER ĐỒNG BỘ TỰ ĐỘNG TỪ auth.users SANG public.users

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger AS $$
DECLARE
  u_username text;
BEGIN
  -- Ưu tiên lấy email đầy đủ làm username để đồng nhất với Auth
  u_username := COALESCE(new.email, new.raw_user_meta_data->>'username', split_part(new.email, '@', 1));

  -- Xóa mọi tài khoản cũ trùng username nhưng khác ID (do local offline cũ hoặc tài khoản đã xóa trên Auth)
  DELETE FROM public.users WHERE username = u_username AND id <> new.id::text;

  INSERT INTO public.users (id, username, display_name, role, password)
  VALUES (
    new.id::text,
    u_username, -- Lưu email đầy đủ hoặc username gốc
    COALESCE(new.raw_user_meta_data->>'display_name', new.raw_user_meta_data->>'displayName', u_username),
    COALESCE(new.raw_user_meta_data->>'role', 'sale'),
    '' -- Không lưu mật khẩu dạng plain-text
  )
  ON CONFLICT (id) DO UPDATE SET
    username = EXCLUDED.username,
    display_name = EXCLUDED.display_name,
    role = EXCLUDED.role;
  RETURN new;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Trigger tự động xác nhận email cho tài khoản mới (tránh lỗi bắt buộc xác nhận email từ Supabase)
CREATE OR REPLACE FUNCTION public.auto_confirm_user()
RETURNS trigger AS $$
BEGIN
  new.email_confirmed_at := COALESCE(new.email_confirmed_at, now());
  RETURN new;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS on_auth_user_created_before ON auth.users;
CREATE TRIGGER on_auth_user_created_before
  BEFORE INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.auto_confirm_user();

-- Gán trigger tạo tài khoản
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- Trigger xóa tài khoản tự động
CREATE OR REPLACE FUNCTION public.handle_deleted_user()
RETURNS trigger AS $$
BEGIN
  DELETE FROM public.users WHERE id = old.id::text;
  RETURN old;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Gán trigger xóa tài khoản
DROP TRIGGER IF EXISTS on_auth_user_deleted ON auth.users;
CREATE TRIGGER on_auth_user_deleted
  AFTER DELETE ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_deleted_user();

-- TỰ ĐỘNG ĐỒNG BỘ CÁC TÀI KHOẢN ĐÃ CÓ TRƯỚC ĐÓ TỪ auth.users SANG public.users (Tránh xung đột ràng buộc)
INSERT INTO public.users (id, username, display_name, role, password)
SELECT DISTINCT ON (uname)
  u.id::text,
  u.uname,
  u.display_name,
  u.role,
  ''
FROM (
  SELECT 
    id,
    split_part(email, '@', 1) as uname,
    COALESCE(raw_user_meta_data->>'display_name', raw_user_meta_data->>'displayName', split_part(email, '@', 1)) as display_name,
    COALESCE(raw_user_meta_data->>'role', 'admin') as role
  FROM auth.users
  WHERE email IS NOT NULL AND email <> ''
) u
WHERE NOT EXISTS (
  SELECT 1 FROM public.users p WHERE p.username = u.uname OR p.id = u.id::text
);


-- ====================================================================
-- 7. LẬP LỊCH TỰ ĐỘNG XÓA ĐƠN NHÁP CŨ HƠN 2 NGÀY (YÊU CẦU EXTENSION pg_cron)
-- ====================================================================
-- Lưu ý: pg_cron cần được bật trong mục Database -> Extensions trên trang quản trị Supabase.

CREATE EXTENSION IF NOT EXISTS pg_cron;

-- Chạy dọn dẹp lúc 00:00 hàng ngày
SELECT cron.schedule(
  'cleanup-old-drafts-job',
  '0 0 * * *',
  $$ DELETE FROM public.draft_orders WHERE created_at < now() - interval '2 days' $$
);

-- ====================================================================
-- 8. TẠO BẢNG HÃNG SƠN (brands) & PHÂN QUYỀN RLS
-- ====================================================================

-- Tạo bảng brands
CREATE TABLE IF NOT EXISTS public.brands (
    name text PRIMARY KEY,
    company_name text NOT NULL,
    logo_filename text NOT NULL,
    hotline text NOT NULL,
    cskh text NOT NULL,
    email text NOT NULL,
    address_main text NOT NULL,
    address_factory text NOT NULL,
    address_business text,
    created_at timestamptz DEFAULT now()
);

-- Kích hoạt RLS
ALTER TABLE public.brands ENABLE ROW LEVEL SECURITY;

-- Tạo chính sách bảo mật
DROP POLICY IF EXISTS select_brands ON brands;
DROP POLICY IF EXISTS manage_brands ON brands;

CREATE POLICY select_brands ON brands FOR SELECT TO authenticated USING (true);
CREATE POLICY manage_brands ON brands FOR ALL TO authenticated USING (public.is_admin_or_accounting());

-- Chèn dữ liệu hạt giống mẫu ban đầu (seeding)
INSERT INTO public.brands (name, company_name, logo_filename, hotline, cskh, email, address_main, address_factory, address_business)
VALUES 
  ('Nano10*', 'CÔNG TY CỔ PHẦN ABS JAPAN', 'absjapan.png', '088.603.7878 - 0961.030.923', '0868.055.866', 'nhamaysonnano@gmail.com', 'Tiên Kha - Phúc Thịnh - Hà Nội', 'TDP Cầu Giao - P.Phúc Thuận - T.Thái Nguyên', '228 Hoàng Hữu Nam - P.Long Bình - Hồ Chí Minh'),
  ('Hatacco nano', 'CÔNG TY CỔ PHẦN EMP HOA KỲ', 'hatacco.png', '0325.855.222 - 0985.769.689', '0868.055.866', 'nhamaysonnano@gmail.com', 'Tiên Kha - Phúc Thịnh - Hà Nội', 'TDP Cầu Giao - P.Phúc Thuận - T.Thái Nguyên', NULL),
  ('Festiva nano', 'CÔNG TY CỔ PHẦN EMP HOA KỲ', 'festiva.png', '0325.855.222 - 0985.769.689', '0868.055.866', 'nhamaysonnano@gmail.com', 'Tiên Kha - Phúc Thịnh - Hà Nội', 'TDP Cầu Giao - P.Phúc Thuận - T.Thái Nguyên', NULL),
  ('mutsutec', 'CÔNG TY CỔ PHẦN ABS JAPAN', 'absjapan.png', '088.603.7878 - 0961.030.923', '0868.055.866', 'nhamaysonnano@gmail.com', 'Tiên Kha - Phúc Thịnh - Hà Nội', 'TDP Cầu Giao - P.Phúc Thuận - T.Thái Nguyên', '228 Hoàng Hữu Nam - P.Long Bình - Hồ Chí Minh'),
  ('tdkaw', 'CÔNG TY CỔ PHẦN ABS JAPAN', 'absjapan.png', '088.603.7878 - 0961.030.923', '0868.055.866', 'nhamaysonnano@gmail.com', 'Tiên Kha - Phúc Thịnh - Hà Nội', 'TDP Cầu Giao - P.Phúc Thuận - T.Thái Nguyên', '228 Hoàng Hữu Nam - P.Long Bình - Hồ Chí Minh'),
  ('cova', 'CÔNG TY CỔ PHẦN ABS JAPAN', 'absjapan.png', '088.603.7878 - 0961.030.923', '0868.055.866', 'nhamaysonnano@gmail.com', 'Tiên Kha - Phúc Thịnh - Hà Nội', 'TDP Cầu Giao - P.Phúc Thuận - T.Thái Nguyên', '228 Hoàng Hữu Nam - P.Long Bình - Hồ Chí Minh')
ON CONFLICT (name) DO NOTHING;

-- Bổ sung cột quản lý kinh doanh ngoài / tài khoản công ty
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS is_external boolean DEFAULT false;

-- Chèn mặc định tài khoản quản lý công ty
INSERT INTO public.users (id, username, display_name, role, password, is_external)
VALUES 
  ('u-abs-japan', 'ctyabs@lendon.com', 'ABS JAPAN (Công ty)', 'sale', '', true),
  ('u-emp-hoa-ky', 'emp_hoa_ky', 'EMP Hoa Kỳ (Công ty)', 'sale', '', true)
ON CONFLICT (username) DO UPDATE SET
  is_external = true,
  display_name = EXCLUDED.display_name;

-- ====================================================================
-- 9. TẠO BẢNG CHO PHÂN HỆ HÀNG HÓA & SẢN XUẤT
-- ====================================================================

-- Bảng nguyên liệu (raw_materials)
CREATE TABLE IF NOT EXISTS public.raw_materials (
    id text PRIMARY KEY,
    code text UNIQUE NOT NULL,
    name text NOT NULL,
    unit text NOT NULL DEFAULT 'kg',
    import_price numeric DEFAULT 0,
    quantity numeric NOT NULL DEFAULT 0,
    notes text,
    created_at timestamptz DEFAULT now()
);

-- Bảng bán thành phẩm (semi_finished)
CREATE TABLE IF NOT EXISTS public.semi_finished (
    id text PRIMARY KEY,
    code text UNIQUE NOT NULL,
    name text NOT NULL,
    unit text NOT NULL DEFAULT 'kg',
    quantity numeric NOT NULL DEFAULT 0,
    notes text,
    created_at timestamptz DEFAULT now()
);

-- Bảng công thức sản xuất (recipes)
CREATE TABLE IF NOT EXISTS public.recipes (
    id text PRIMARY KEY,
    name text NOT NULL,
    semi_finished_id text,
    output_quantity numeric NOT NULL DEFAULT 1,
    ingredients jsonb NOT NULL DEFAULT '[]'::jsonb, -- [{rawMaterialId, quantity}]
    notes text,
    created_at timestamptz DEFAULT now()
);

-- Bảng nhật ký sản xuất (production_logs)
CREATE TABLE IF NOT EXISTS public.production_logs (
    id text PRIMARY KEY,
    recipe_id text,
    recipe_name text NOT NULL,
    semi_finished_name text NOT NULL,
    quantity numeric NOT NULL,
    raw_materials_used jsonb NOT NULL DEFAULT '[]'::jsonb, -- [{rawMaterialId, rawMaterialName, quantityUsed}]
    created_by text,
    created_at timestamptz DEFAULT now()
);

-- Bảng tồn kho thành phẩm (finished_goods_stock)
CREATE TABLE IF NOT EXISTS public.finished_goods_stock (
    product_code text NOT NULL,
    brand text NOT NULL,
    package_type text NOT NULL, -- 'thung', 'lon', 'hop', 'bao', 'tui'
    quantity numeric NOT NULL DEFAULT 0,
    updated_at timestamptz DEFAULT now(),
    CONSTRAINT finished_goods_stock_pk PRIMARY KEY (product_code, brand, package_type)
);

-- Kích hoạt RLS cho các bảng mới
ALTER TABLE public.raw_materials ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.semi_finished ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.recipes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.production_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.finished_goods_stock ENABLE ROW LEVEL SECURITY;

-- Các chính sách bảo mật RLS
DROP POLICY IF EXISTS select_raw_materials ON raw_materials;
DROP POLICY IF EXISTS manage_raw_materials ON raw_materials;
CREATE POLICY select_raw_materials ON raw_materials FOR SELECT TO authenticated USING (true);
CREATE POLICY manage_raw_materials ON raw_materials FOR ALL TO authenticated USING (public.is_admin_or_accounting());

DROP POLICY IF EXISTS select_semi_finished ON semi_finished;
DROP POLICY IF EXISTS manage_semi_finished ON semi_finished;
CREATE POLICY select_semi_finished ON semi_finished FOR SELECT TO authenticated USING (true);
CREATE POLICY manage_semi_finished ON semi_finished FOR ALL TO authenticated USING (public.is_admin_or_accounting());

DROP POLICY IF EXISTS select_recipes ON recipes;
DROP POLICY IF EXISTS manage_recipes ON recipes;
CREATE POLICY select_recipes ON recipes FOR SELECT TO authenticated USING (true);
CREATE POLICY manage_recipes ON recipes FOR ALL TO authenticated USING (public.is_admin_or_accounting());

DROP POLICY IF EXISTS select_production_logs ON production_logs;
DROP POLICY IF EXISTS manage_production_logs ON production_logs;
CREATE POLICY select_production_logs ON production_logs FOR SELECT TO authenticated USING (true);
CREATE POLICY manage_production_logs ON production_logs FOR ALL TO authenticated USING (public.is_admin_or_accounting());

DROP POLICY IF EXISTS select_finished_goods_stock ON finished_goods_stock;
DROP POLICY IF EXISTS manage_finished_goods_stock ON finished_goods_stock;
CREATE POLICY select_finished_goods_stock ON finished_goods_stock FOR SELECT TO authenticated USING (true);
CREATE POLICY manage_finished_goods_stock ON finished_goods_stock FOR ALL TO authenticated USING (public.is_admin_or_accounting());

-- 10. TẠO BẢNG SỔ QUỸ (cashbook_transactions) VÀ CẤP QUYỀN RLS
CREATE TABLE IF NOT EXISTS public.cashbook_transactions (
    id text PRIMARY KEY,
    date timestamptz DEFAULT now(),
    type text NOT NULL,
    category text,
    partner text,
    value numeric DEFAULT 0,
    method text DEFAULT 'cash',
    accounting boolean DEFAULT true,
    status text DEFAULT 'Đã thanh toán',
    creator text,
    note text,
    starred boolean DEFAULT false
);

ALTER TABLE public.cashbook_transactions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS select_cashbook ON cashbook_transactions;
DROP POLICY IF EXISTS manage_cashbook ON cashbook_transactions;
CREATE POLICY select_cashbook ON cashbook_transactions FOR SELECT USING (true);
CREATE POLICY manage_cashbook ON cashbook_transactions FOR ALL USING (true) WITH CHECK (true);

-- 11. TẠO BẢNG TRẢ HÀNG (sales_returns & sales_return_items) VÀ CẤP QUYỀN RLS
CREATE TABLE IF NOT EXISTS public.sales_returns (
    id text PRIMARY KEY,
    sale_id text NOT NULL,
    customer_id text,
    created_by text,
    created_at timestamptz DEFAULT now(),
    reason text,
    total_refund numeric DEFAULT 0,
    status text DEFAULT 'completed'
);

CREATE TABLE IF NOT EXISTS public.sales_return_items (
    id text PRIMARY KEY,
    return_id text NOT NULL,
    sale_item_id text,
    product_id text,
    product_name text,
    quantity numeric DEFAULT 0,
    import_price numeric DEFAULT 0,
    discount_type text DEFAULT 'percent',
    discount_value numeric DEFAULT 0,
    refund_price numeric DEFAULT 0,
    subtotal numeric DEFAULT 0,
    package_type text
);

ALTER TABLE public.sales_returns ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sales_return_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS manage_sales_returns ON sales_returns;
CREATE POLICY manage_sales_returns ON sales_returns FOR ALL USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS manage_sales_return_items ON sales_return_items;
CREATE POLICY manage_sales_return_items ON sales_return_items FOR ALL USING (true) WITH CHECK (true);

-- 12. BẢNG CUSTOMER_DEBT_TRANSACTIONS
CREATE TABLE IF NOT EXISTS customer_debt_transactions (
    id text PRIMARY KEY,
    customer_id text NOT NULL,
    transaction_type text NOT NULL, -- 'order', 'payment', 'return', 'adjust'
    amount numeric DEFAULT 0,
    debt_change numeric DEFAULT 0,
    balance_before numeric DEFAULT 0,
    balance_after numeric DEFAULT 0,
    order_id text,
    sales_return_id text,
    cashbook_transaction_id text,
    starting_balance_id text,
    employee_id text,
    description text,
    transaction_date timestamptz DEFAULT now(),
    created_by text,
    created_at timestamptz DEFAULT now()
);

-- 12b. BẢNG CUSTOMER_ASSIGNMENTS (Phân công chăm sóc khách hàng)
CREATE TABLE IF NOT EXISTS customer_assignments (
    id text PRIMARY KEY,
    customer_id text NOT NULL,
    employee_id text NOT NULL,
    brand_id text,
    assigned_from timestamptz DEFAULT now(),
    assigned_to timestamptz,
    is_active boolean DEFAULT true,
    assigned_by text,
    reason text,
    created_at timestamptz DEFAULT now()
);

-- 12c. BẢNG COMMISSION_RULES (Quy tắc hoa hồng)
CREATE TABLE IF NOT EXISTS commission_rules (
    id text PRIMARY KEY,
    name text NOT NULL,
    employee_id text,
    position text,
    brand_id text,
    product_group_id text,
    calculation_basis text DEFAULT 'revenue',
    commission_rate numeric DEFAULT 0,
    fixed_amount numeric DEFAULT 0,
    minimum_revenue numeric DEFAULT 0,
    maximum_revenue numeric,
    effective_from timestamptz DEFAULT now(),
    effective_to timestamptz,
    is_active boolean DEFAULT true
);

-- 12d. BẢNG COMMISSION_TRANSACTIONS (Giao dịch hoa hồng)
CREATE TABLE IF NOT EXISTS commission_transactions (
    id text PRIMARY KEY,
    employee_id text NOT NULL,
    salary_period text,
    order_id text,
    sales_return_id text,
    cashbook_transaction_id text,
    transaction_type text NOT NULL,
    calculation_basis text,
    basis_amount numeric DEFAULT 0,
    commission_rate numeric DEFAULT 0,
    commission_amount numeric DEFAULT 0,
    rule_id text,
    status text DEFAULT 'pending',
    calculated_at timestamptz DEFAULT now(),
    created_at timestamptz DEFAULT now()
);

ALTER TABLE customer_debt_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE commission_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE commission_transactions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS manage_customer_debt_transactions ON customer_debt_transactions;
CREATE POLICY manage_customer_debt_transactions ON customer_debt_transactions FOR ALL USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS manage_customer_assignments ON customer_assignments;
CREATE POLICY manage_customer_assignments ON customer_assignments FOR ALL USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS manage_commission_rules ON commission_rules;
CREATE POLICY manage_commission_rules ON commission_rules FOR ALL USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS manage_commission_transactions ON commission_transactions;
CREATE POLICY manage_commission_transactions ON commission_transactions FOR ALL USING (true) WITH CHECK (true);

-- 13. DỌN DẸP DỮ LIỆU MỒ CÔI (ORPHAN DATA) TRƯỚC KHI TẠO RÀNG BUỘC KHÓA NGOẠI
UPDATE orders SET customer_id = NULL WHERE customer_id IS NOT NULL AND customer_id NOT IN (SELECT id FROM customers);
UPDATE sales_returns SET customer_id = NULL WHERE customer_id IS NOT NULL AND customer_id NOT IN (SELECT id FROM customers);
UPDATE sales_returns SET order_id = NULL WHERE order_id IS NOT NULL AND order_id NOT IN (SELECT id FROM orders);
UPDATE cashbook_transactions SET customer_id = NULL WHERE customer_id IS NOT NULL AND customer_id NOT IN (SELECT id FROM customers);
UPDATE cashbook_transactions SET order_id = NULL WHERE order_id IS NOT NULL AND order_id NOT IN (SELECT id FROM orders);

-- 14. TẠO CÁC RÀNG BUỘC KHÓA NGOẠI (FOREIGN KEYS) AN TOÀN VÀ KHÔNG GÂY LỖI
DO $$ 
BEGIN
    BEGIN
        ALTER TABLE orders ADD CONSTRAINT fk_orders_customer FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE SET NULL;
    EXCEPTION WHEN duplicate_object THEN NULL; WHEN undefined_table THEN NULL; WHEN foreign_key_violation THEN NULL; END;

    BEGIN
        ALTER TABLE order_items ADD CONSTRAINT fk_order_items_order FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE;
    EXCEPTION WHEN duplicate_object THEN NULL; WHEN undefined_table THEN NULL; WHEN foreign_key_violation THEN NULL; END;

    BEGIN
        ALTER TABLE sales_returns ADD CONSTRAINT fk_sales_returns_customer FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE SET NULL;
    EXCEPTION WHEN duplicate_object THEN NULL; WHEN undefined_table THEN NULL; WHEN foreign_key_violation THEN NULL; END;

    BEGIN
        ALTER TABLE sales_returns ADD CONSTRAINT fk_sales_returns_order FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE SET NULL;
    EXCEPTION WHEN duplicate_object THEN NULL; WHEN undefined_table THEN NULL; WHEN foreign_key_violation THEN NULL; END;

    BEGIN
        ALTER TABLE cashbook_transactions ADD CONSTRAINT fk_cashbook_customer FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE SET NULL;
    EXCEPTION WHEN duplicate_object THEN NULL; WHEN undefined_table THEN NULL; WHEN foreign_key_violation THEN NULL; END;

    BEGIN
        ALTER TABLE cashbook_transactions ADD CONSTRAINT fk_cashbook_order FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE SET NULL;
    EXCEPTION WHEN duplicate_object THEN NULL; WHEN undefined_table THEN NULL; WHEN foreign_key_violation THEN NULL; END;

    BEGIN
        ALTER TABLE customer_debt_transactions ADD CONSTRAINT fk_debt_tx_customer FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE;
    EXCEPTION WHEN duplicate_object THEN NULL; WHEN undefined_table THEN NULL; WHEN foreign_key_violation THEN NULL; END;
END $$;

-- 15. THỦ TỤC GIAO DỊCH DATABASE TRANSACTIONS (RPC FUNCTIONS)

-- rpc_confirm_order is intentionally defined by migration_order_price_snapshots.sql.
-- Keeping the implementation in one migration prevents the base schema from
-- overwriting SKU validation and immutable price snapshots.

CREATE OR REPLACE FUNCTION rpc_record_customer_payment(
    p_customer_id text, p_amount numeric, p_notes text, p_created_by text
) RETURNS jsonb AS $$
DECLARE
    v_bal_before numeric := 0;
    v_bal_after numeric := 0;
    v_debt_change numeric := 0;
    v_tx_id text;
    v_cashbook_id text;
BEGIN
    IF p_customer_id IS NULL OR p_customer_id = '' THEN
        RAISE EXCEPTION 'Customer ID cannot be null';
    END IF;

    SELECT COALESCE(debt, 0) INTO v_bal_before FROM customers WHERE id = p_customer_id FOR UPDATE;
    v_debt_change := CASE WHEN v_bal_before < 0 THEN p_amount ELSE -p_amount END;
    v_bal_after := v_bal_before + v_debt_change;
    v_cashbook_id := 'cb-' || floor(extract(epoch from now()) * 1000)::text;
    v_tx_id := 'dtx-pay-' || floor(extract(epoch from now()) * 1000)::text;

    INSERT INTO cashbook_transactions (
        id, date, transaction_date, type, transaction_type, direction, category, partner, customer_id,
        value, method, payment_method, accounting, status, creator, created_by, note
    ) VALUES (
        v_cashbook_id, now(), now(), 'thu', 'Thu nợ khách hàng', 'in', 'Thu nợ khách hàng',
        (SELECT name FROM customers WHERE id = p_customer_id), p_customer_id,
        p_amount, 'cash', 'cash', true, 'Đã thanh toán', p_created_by, p_created_by, p_notes
    );

    INSERT INTO customer_debt_transactions (
        id, customer_id, transaction_type, amount, debt_change,
        balance_before, balance_after, cashbook_transaction_id, description, created_by, transaction_date
    ) VALUES (
            v_tx_id, p_customer_id, 'payment', p_amount, v_debt_change,
        v_bal_before, v_bal_after, v_cashbook_id, COALESCE(p_notes, 'Thu tiền nợ'), p_created_by, now()
    );

    UPDATE customers SET
        debt = v_bal_after,
        last_payment_at = now(),
        updated_at = now()
    WHERE id = p_customer_id;

    RETURN jsonb_build_object('success', true, 'cashbook_id', v_cashbook_id, 'new_debt', v_bal_after);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION rpc_record_sales_return(
    p_return_id text, p_sale_id text, p_customer_id text, p_total_refund numeric,
    p_reason text, p_created_by text, p_items jsonb, p_order_status text
) RETURNS jsonb AS $$
DECLARE
    v_bal_before numeric := 0;
    v_bal_after numeric := 0;
    v_tx_id text;
BEGIN
    INSERT INTO sales_returns (
        id, sale_id, order_id, customer_id, salesperson_id, total_return_amount,
        debt_reduction_amount, refund_amount, total_refund, reason, status, created_by, created_at, return_date
    ) VALUES (
        p_return_id, p_sale_id, p_sale_id, p_customer_id, p_created_by, p_total_refund,
        p_total_refund, 0, p_total_refund, p_reason, 'completed', p_created_by, now(), now()
    ) ON CONFLICT (id) DO UPDATE SET
        total_refund = EXCLUDED.total_refund,
        status = EXCLUDED.status;

    IF p_sale_id IS NOT NULL THEN
        UPDATE orders SET status = p_order_status, updated_at = now() WHERE id = p_sale_id;
    END IF;

    IF p_customer_id IS NOT NULL AND p_customer_id <> '' THEN
        SELECT COALESCE(debt, 0) INTO v_bal_before FROM customers WHERE id = p_customer_id FOR UPDATE;
        v_bal_after := v_bal_before - p_total_refund;

        v_tx_id := 'dtx-ret-' || p_return_id || '-' || floor(extract(epoch from now()) * 1000)::text;
        INSERT INTO customer_debt_transactions (
            id, customer_id, transaction_type, amount, debt_change,
            balance_before, balance_after, sales_return_id, order_id, description, created_by, transaction_date
        ) VALUES (
            v_tx_id, p_customer_id, 'return', p_total_refund, -p_total_refund,
            v_bal_before, v_bal_after, p_return_id, p_sale_id, 'Phiếu trả hàng ' || p_return_id || ': ' || COALESCE(p_reason, ''), p_created_by, now()
        );

        UPDATE customers SET
            total_return = COALESCE(total_return, 0) + p_total_refund,
            net_revenue = COALESCE(net_revenue, 0) - p_total_refund,
            debt = v_bal_after,
            updated_at = now()
        WHERE id = p_customer_id;
    END IF;

    RETURN jsonb_build_object('success', true, 'return_id', p_return_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION rpc_adjust_customer_debt(
    p_customer_id text, p_new_debt numeric, p_description text, p_created_by text
) RETURNS jsonb AS $$
DECLARE
    v_bal_before numeric := 0;
    v_debt_change numeric := 0;
    v_tx_id text;
BEGIN
    IF p_customer_id IS NULL OR p_customer_id = '' THEN
        RAISE EXCEPTION 'Customer ID cannot be null';
    END IF;

    SELECT COALESCE(debt, 0) INTO v_bal_before FROM customers WHERE id = p_customer_id FOR UPDATE;
    v_debt_change := p_new_debt - v_bal_before;
    v_tx_id := 'dtx-adj-' || floor(extract(epoch from now()) * 1000)::text;

    INSERT INTO customer_debt_transactions (
        id, customer_id, transaction_type, amount, debt_change,
        balance_before, balance_after, description, created_by, transaction_date
    ) VALUES (
        v_tx_id, p_customer_id, 'adjust', ABS(v_debt_change), v_debt_change,
        v_bal_before, p_new_debt, COALESCE(p_description, 'Điều chỉnh công nợ'), p_created_by, now()
-- 16. BẢNG AUDIT LOGS (Nhật ký truy vết thao tác)
CREATE TABLE IF NOT EXISTS audit_logs (
    id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
    table_name text NOT NULL,
    action text NOT NULL,
    record_id text,
    old_data jsonb,
    new_data jsonb,
    performed_by text,
    created_at timestamptz DEFAULT now()
);

ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS manage_audit_logs ON audit_logs;
CREATE POLICY manage_audit_logs ON audit_logs FOR ALL USING (true) WITH CHECK (true);

-- 17. THỦ TỤC VÀ TRIGGER CHO AUDIT LOGS
CREATE OR REPLACE FUNCTION rpc_log_audit_trail() RETURNS TRIGGER AS $$
BEGIN
    IF (TG_OP = 'DELETE') THEN
        INSERT INTO audit_logs (table_name, action, record_id, old_data, performed_by, created_at)
        VALUES (TG_TABLE_NAME, 'DELETE', OLD.id, to_jsonb(OLD), COALESCE(current_setting('app.current_user', true), 'system'), now());
        RETURN OLD;
    ELSIF (TG_OP = 'UPDATE') THEN
        INSERT INTO audit_logs (table_name, action, record_id, old_data, new_data, performed_by, created_at)
        VALUES (TG_TABLE_NAME, 'UPDATE', NEW.id, to_jsonb(OLD), to_jsonb(NEW), COALESCE(current_setting('app.current_user', true), 'system'), now());
        RETURN NEW;
    ELSIF (TG_OP = 'INSERT') THEN
        INSERT INTO audit_logs (table_name, action, record_id, new_data, performed_by, created_at)
        VALUES (TG_TABLE_NAME, 'INSERT', NEW.id, to_jsonb(NEW), COALESCE(current_setting('app.current_user', true), 'system'), now());
        RETURN NEW;
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_audit_customers ON customers;
CREATE TRIGGER trg_audit_customers AFTER INSERT OR UPDATE OR DELETE ON customers FOR EACH ROW EXECUTE FUNCTION rpc_log_audit_trail();

DROP TRIGGER IF EXISTS trg_audit_orders ON orders;
CREATE TRIGGER trg_audit_orders AFTER INSERT OR UPDATE OR DELETE ON orders FOR EACH ROW EXECUTE FUNCTION rpc_log_audit_trail();

DROP TRIGGER IF EXISTS trg_audit_returns ON sales_returns;
CREATE TRIGGER trg_audit_returns AFTER INSERT OR UPDATE OR DELETE ON sales_returns FOR EACH ROW EXECUTE FUNCTION rpc_log_audit_trail();

-- 18. PRE-COMPUTED VIEWS PHÂN TÍCH TỐC ĐỘ CAO
CREATE OR REPLACE VIEW v_customer_summary AS
SELECT 
    c.id, c.code, c.name, c.phone, c.phone2, c.email, c.address, c.province, c.ward,
    c.status, c.debt, c.total_transaction, c.total_return, c.net_revenue, c.managed_by,
    c.last_order_at, c.last_payment_at, c.created_at,
    COUNT(o.id) AS total_orders_count
FROM customers c
LEFT JOIN orders o ON o.customer_id = c.id
GROUP BY c.id;

CREATE OR REPLACE VIEW v_dashboard_metrics AS
SELECT 
    COALESCE(SUM(total_payable), 0) AS gross_revenue,
    COUNT(id) AS total_orders,
    COALESCE(SUM(paid_amount), 0) AS total_paid,
    COALESCE(SUM(debt_amount), 0) AS total_debt
FROM orders
WHERE status <> 'cancelled';

-- 19. RPC PHÂN TRANG VÀ LAZY LOADING SERVER-SIDE (100.000 KHÁCH HÀNG & 1.000.000 ĐƠN HÀNG)
CREATE OR REPLACE FUNCTION rpc_get_customers_paginated(
    p_search text DEFAULT '',
    p_managed_by text DEFAULT NULL,
    p_limit int DEFAULT 50,
    p_offset int DEFAULT 0
) RETURNS jsonb AS $$
DECLARE
    v_total bigint;
    v_data jsonb;
BEGIN
    SELECT COUNT(*) INTO v_total
    FROM customers
    WHERE (p_search = '' OR code ILIKE '%' || p_search || '%' OR name ILIKE '%' || p_search || '%' OR phone ILIKE '%' || p_search || '%')
      AND (p_managed_by IS NULL OR p_managed_by = 'all' OR managed_by = p_managed_by);

    SELECT jsonb_agg(to_jsonb(c)) INTO v_data
    FROM (
        SELECT *
        FROM customers
        WHERE (p_search = '' OR code ILIKE '%' || p_search || '%' OR name ILIKE '%' || p_search || '%' OR phone ILIKE '%' || p_search || '%')
          AND (p_managed_by IS NULL OR p_managed_by = 'all' OR managed_by = p_managed_by)
        ORDER BY created_at DESC
        LIMIT p_limit OFFSET p_offset
    ) c;

    RETURN jsonb_build_object(
        'total', v_total,
        'limit', p_limit,
        'offset', p_offset,
        'data', COALESCE(v_data, '[]'::jsonb)
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION rpc_get_orders_paginated(
    p_search text DEFAULT '',
    p_status text DEFAULT NULL,
    p_customer_id text DEFAULT NULL,
    p_limit int DEFAULT 50,
    p_offset int DEFAULT 0
) RETURNS jsonb AS $$
DECLARE
    v_total bigint;
    v_data jsonb;
BEGIN
    SELECT COUNT(*) INTO v_total
    FROM orders
    WHERE (p_search = '' OR id ILIKE '%' || p_search || '%' OR customer_name ILIKE '%' || p_search || '%')
      AND (p_status IS NULL OR p_status = 'all' OR status = p_status)
      AND (p_customer_id IS NULL OR customer_id = p_customer_id);

    SELECT jsonb_agg(to_jsonb(o)) INTO v_data
    FROM (
        SELECT *
        FROM orders
        WHERE (p_search = '' OR id ILIKE '%' || p_search || '%' OR customer_name ILIKE '%' || p_search || '%')
          AND (p_status IS NULL OR p_status = 'all' OR status = p_status)
          AND (p_customer_id IS NULL OR customer_id = p_customer_id)
        ORDER BY order_date DESC, created_at DESC
        LIMIT p_limit OFFSET p_offset
    ) o;

    RETURN jsonb_build_object(
        'total', v_total,
        'limit', p_limit,
        'offset', p_offset,
        'data', COALESCE(v_data, '[]'::jsonb)
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
