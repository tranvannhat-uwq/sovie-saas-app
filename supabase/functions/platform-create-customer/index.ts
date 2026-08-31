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

function getErrorMessage(error: unknown) {
  if (error instanceof Error && error.message) return error.message;
  if (error && typeof error === 'object' && 'message' in error) {
    const message = String((error as { message?: unknown }).message || '').trim();
    if (message) return message;
  }
  return 'Không thể tạo khách hàng SaaS.';
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (request.method !== 'POST') return jsonResponse({ error: 'Method not allowed.' }, 405);

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const appUrl = String(Deno.env.get('APP_URL') || 'https://sovie.vn').replace(/\/$/, '');
  const authorization = request.headers.get('Authorization');
  if (!supabaseUrl || !anonKey || !serviceRoleKey) {
    return jsonResponse({ error: 'Supabase function chưa được cấu hình đầy đủ.' }, 500);
  }
  if (!authorization?.startsWith('Bearer ')) return jsonResponse({ error: 'Bạn cần đăng nhập lại.' }, 401);

  let createdAuthUserId = '';
  try {
    const callerClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authorization } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: authData, error: authError } = await callerClient.auth.getUser();
    if (authError || !authData.user) return jsonResponse({ error: 'Phiên đăng nhập không hợp lệ.' }, 401);

    const { data: isOwner, error: roleError } = await callerClient
      .rpc('is_platform_staff', { p_roles: ['platform_owner'] });
    if (roleError || isOwner !== true) return jsonResponse({ error: 'Chỉ chủ nền tảng mới được tạo khách hàng.' }, 403);

    const payload = await request.json();
    const email = String(payload?.ownerEmail || '').trim().toLowerCase();
    const displayName = String(payload?.ownerName || '').trim();
    const name = String(payload?.name || '').trim();
    const slug = String(payload?.slug || '').trim().toLowerCase();
    const planId = String(payload?.planId || 'starter').trim().toLowerCase();
    const trialDays = Number(payload?.trialDays || 14);
    const businessType = String(payload?.businessType || 'general_trade').trim().toLowerCase();
    const industryKey = String(payload?.industryKey || 'general').trim().toLowerCase();

    if (!/^\S+@\S+\.\S+$/.test(email)) return jsonResponse({ error: 'Email Owner không hợp lệ.' }, 400);
    if (displayName.length < 2) return jsonResponse({ error: 'Tên Owner phải có ít nhất 2 ký tự.' }, 400);

    const adminClient = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: existingProfile, error: profileLookupError } = await adminClient
      .from('profiles')
      .select('id,auth_user_id,username,display_name,is_active')
      .ilike('username', email)
      .maybeSingle();
    if (profileLookupError) return jsonResponse({ error: profileLookupError.message }, 500);

    let ownerAuthUserId = String(existingProfile?.auth_user_id || '');
    let invitationSent = false;
    if (!ownerAuthUserId) {
      for (let page = 1; page <= 50 && !ownerAuthUserId; page += 1) {
        const { data: usersPage, error: usersError } = await adminClient.auth.admin.listUsers({ page, perPage: 1000 });
        if (usersError) throw usersError;
        const matchedUser = usersPage.users.find(user => String(user.email || '').toLowerCase() === email);
        if (matchedUser) ownerAuthUserId = matchedUser.id;
        if (usersPage.users.length < 1000) break;
      }
    }
    if (!ownerAuthUserId) {
      const { data: invited, error: inviteError } = await adminClient.auth.admin.inviteUserByEmail(email, {
        data: { display_name: displayName },
        redirectTo: appUrl,
      });
      if (inviteError || !invited.user) {
        return jsonResponse({ error: inviteError?.message || 'Không thể gửi email mời Owner.' }, 400);
      }
      ownerAuthUserId = invited.user.id;
      createdAuthUserId = invited.user.id;
      invitationSent = true;
    }

    const { data: updatedProfile, error: profileUpdateError } = await adminClient.from('profiles').update({
      username: email,
      display_name: displayName,
      is_external: false,
      is_active: true,
      updated_at: new Date().toISOString(),
    }).eq('auth_user_id', ownerAuthUserId).select('id').maybeSingle();
    if (profileUpdateError || !updatedProfile) {
      throw profileUpdateError || new Error('Tài khoản Owner chưa có hồ sơ ứng dụng hợp lệ.');
    }

    const { data: organization, error: provisionError } = await callerClient
      .rpc('rpc_platform_provision_customer', {
        p_owner_auth_user_id: ownerAuthUserId,
        p_name: name,
        p_slug: slug,
        p_plan_id: planId,
        p_trial_days: trialDays,
        p_business_type: businessType,
        p_industry_key: industryKey,
      });
    if (provisionError) throw provisionError;

    return jsonResponse({ organization, owner: { email, displayName }, invitationSent }, 201);
  } catch (error) {
    if (createdAuthUserId) {
      const adminClient = createClient(supabaseUrl, serviceRoleKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      await adminClient.auth.admin.deleteUser(createdAuthUserId);
    }
    console.error('platform-create-customer failed', error);
    return jsonResponse({ error: getErrorMessage(error) }, 400);
  }
});
