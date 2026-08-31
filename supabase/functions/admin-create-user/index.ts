import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (request.method !== 'POST') return jsonResponse({ error: 'Method not allowed.' }, 405);

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const authorization = request.headers.get('Authorization');
  if (!supabaseUrl || !anonKey || !serviceRoleKey) {
    return jsonResponse({ error: 'Supabase function chưa được cấu hình đầy đủ.' }, 500);
  }
  if (!authorization?.startsWith('Bearer ')) {
    return jsonResponse({ error: 'Bạn cần đăng nhập lại.' }, 401);
  }

  try {
    const callerClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authorization } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: authData, error: authError } = await callerClient.auth.getUser();
    if (authError || !authData.user) return jsonResponse({ error: 'Phiên đăng nhập không hợp lệ.' }, 401);

    const { data: tenantContext, error: contextError } = await callerClient
      .rpc('rpc_my_saas_context');
    const activeOrganizationId = String(tenantContext?.activeOrganizationId || '');
    const activeOrganization = Array.isArray(tenantContext?.organizations)
      ? tenantContext.organizations.find((item: { id?: string }) => String(item?.id || '') === activeOrganizationId)
      : null;
    if (contextError || !activeOrganization || !['owner', 'admin'].includes(String(activeOrganization.role || ''))) {
      return jsonResponse({ error: 'Chỉ Owner hoặc Admin của workspace hiện tại mới được tạo thành viên.' }, 403);
    }

    const payload = await request.json();
    const email = String(payload?.email || '').trim().toLowerCase();
    const password = String(payload?.password || '');
    const displayName = String(payload?.displayName || '').trim();
    const role = String(payload?.role || 'sale');
    const companyId = String(payload?.companyId || 'ABS_NORTH').trim();

    if (!/^\S+@\S+\.\S+$/.test(email)) return jsonResponse({ error: 'Email đăng nhập không hợp lệ.' }, 400);
    if (password.length < 8) return jsonResponse({ error: 'Mật khẩu phải có ít nhất 8 ký tự.' }, 400);
    if (!displayName) return jsonResponse({ error: 'Tên hiển thị là bắt buộc.' }, 400);
    if (!['admin', 'accounting', 'sale'].includes(role)) return jsonResponse({ error: 'Vai trò không hợp lệ.' }, 400);
    if (!companyId) return jsonResponse({ error: 'Công ty trực thuộc là bắt buộc.' }, 400);

    const adminClient = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: created, error: createError } = await adminClient.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { display_name: displayName },
    });
    if (createError || !created.user) {
      const duplicate = /already|registered|exists/i.test(createError?.message || '');
      return jsonResponse({
        error: duplicate ? 'Email đăng nhập đã tồn tại trong Supabase Auth.' : (createError?.message || 'Không thể tạo Auth user.'),
      }, duplicate ? 409 : 400);
    }

    const { data: profile, error: updateError } = await adminClient
      .from('profiles')
      .update({
        username: email,
        display_name: displayName,
        role,
        company_id: companyId,
        is_external: false,
        is_active: true,
        updated_at: new Date().toISOString(),
      })
      .eq('auth_user_id', created.user.id)
      .select('id,auth_user_id,username,display_name,role,company_id,is_external,is_active')
      .single();

    if (updateError || !profile) {
      await adminClient.auth.admin.deleteUser(created.user.id);
      return jsonResponse({ error: updateError?.message || 'Không thể tạo profile; Auth user đã được hoàn tác.' }, 500);
    }

    const { data: membership, error: membershipError } = await callerClient
      .rpc('rpc_add_organization_member', {
        p_auth_user_id: created.user.id,
        p_role: role,
      });
    if (membershipError || !membership?.membershipId) {
      await adminClient.auth.admin.deleteUser(created.user.id);
      return jsonResponse({
        error: membershipError?.message || 'Không thể thêm tài khoản vào workspace; Auth user đã được hoàn tác.',
      }, 400);
    }

    return jsonResponse({ user: { id: created.user.id, email: created.user.email }, profile, membership }, 201);
  } catch (error) {
    return jsonResponse({ error: error instanceof Error ? error.message : 'Lỗi không xác định.' }, 500);
  }
});
