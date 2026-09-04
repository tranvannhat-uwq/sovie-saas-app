import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const businessTypes = new Set([
  'general_trade', 'retail', 'wholesale', 'distribution', 'services', 'manufacturing',
]);
const reservedSlugs = new Set([
  'www', 'app', 'api', 'admin', 'auth', 'dashboard', 'billing', 'support', 'status',
  'mail', 'cdn', 'static', 'assets', 'docs', 'help', 'system', 'platform', 'sovie',
]);
const maxSubscriptionTermDays = 3650;
const industryAliases: Record<string, string> = {
  'da-nganh': 'general',
  'tong-hop': 'general',
  'thuong-mai-tong-hop': 'general',
  'ban-le': 'retail',
  'thuc-pham-do-uong': 'food_beverage',
  'thoi-trang': 'fashion',
  'xay-dung-vat-lieu': 'construction',
  'tu-van-dich-vu': 'consulting',
  'san-xuat': 'manufacturing',
  'son-phan-phoi': 'paint_distribution',
};

type ProfileSnapshot = {
  id: string;
  auth_user_id: string | null;
  username: string;
  display_name: string;
  is_external: boolean;
  is_active: boolean;
};

type ProfileRollback =
  | { mode: 'delete'; id: string }
  | { mode: 'restore'; snapshot: ProfileSnapshot };

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

function asciiKey(value: unknown) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/gi, 'd')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '')
    .slice(0, 63);
}

function normalizeIndustryKey(value: unknown) {
  const normalized = asciiKey(value || 'general');
  return industryAliases[normalized] || normalized || 'general';
}

function getErrorMessage(error: unknown) {
  const fallback = 'Không thể tạo khách hàng SaaS.';
  const rawMessage = error instanceof Error
    ? error.message
    : error && typeof error === 'object' && 'message' in error
      ? String((error as { message?: unknown }).message || '')
      : '';
  const message = rawMessage.trim();
  if (!message) return fallback;

  const translations: Array<[RegExp, string]> = [
    [/Invalid industry key/i, 'Ngành nghề không hợp lệ. Vui lòng chọn một ngành trong danh sách.'],
    [/Unsupported business type/i, 'Mô hình kinh doanh không hợp lệ.'],
    [/Active SaaS plan required/i, 'Gói dịch vụ không còn hoạt động. Vui lòng tải lại danh sách gói.'],
    [/Organization slug is already in use/i, 'Tên miền con này vừa được sử dụng. Vui lòng chọn tên khác.'],
    [/Invalid or reserved organization slug/i, 'Tên miền con không hợp lệ hoặc đã được hệ thống giữ lại.'],
    [/Active Auth-linked owner profile required/i, 'Tài khoản Owner chưa có hồ sơ ứng dụng hợp lệ.'],
    [/Platform staff cannot own a customer organization/i, 'Tài khoản quản trị nền tảng không thể đồng thời làm Owner khách hàng.'],
  ];
  return translations.find(([pattern]) => pattern.test(message))?.[1] || message;
}

function validatePayload(payload: Record<string, unknown>) {
  const normalized = {
    email: String(payload?.ownerEmail || '').trim().toLowerCase(),
    displayName: String(payload?.ownerName || '').trim(),
    name: String(payload?.name || '').trim(),
    slug: String(payload?.slug || '').trim().toLowerCase(),
    planId: String(payload?.planId || 'starter').trim().toLowerCase(),
    trialDays: Number(payload?.trialDays ?? 14),
    businessType: String(payload?.businessType || 'general_trade').trim().toLowerCase(),
    industryKey: normalizeIndustryKey(payload?.industryKey),
  };

  if (!/^\S+@\S+\.\S+$/.test(normalized.email)) throw new Error('Email Owner không hợp lệ.');
  if (normalized.displayName.length < 2 || normalized.displayName.length > 120) {
    throw new Error('Tên Owner phải có từ 2 đến 120 ký tự.');
  }
  if (normalized.name.length < 2 || normalized.name.length > 120) {
    throw new Error('Tên doanh nghiệp phải có từ 2 đến 120 ký tự.');
  }
  if (!/^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/.test(normalized.slug) || reservedSlugs.has(normalized.slug)) {
    throw new Error('Tên miền con không hợp lệ hoặc đã được hệ thống giữ lại.');
  }
  if (!businessTypes.has(normalized.businessType)) throw new Error('Mô hình kinh doanh không hợp lệ.');
  if (!/^[a-z0-9][a-z0-9_-]{1,62}$/.test(normalized.industryKey)) {
    throw new Error('Ngành nghề không hợp lệ. Vui lòng chọn một ngành trong danh sách.');
  }
  if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(normalized.planId)) throw new Error('Gói dịch vụ không hợp lệ.');
  if (!Number.isInteger(normalized.trialDays) || normalized.trialDays < 1 || normalized.trialDays > maxSubscriptionTermDays) {
    throw new Error(`Thời hạn gói phải từ 1 đến ${maxSubscriptionTermDays.toLocaleString('vi-VN')} ngày.`);
  }
  return normalized;
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
  let profileRollback: ProfileRollback | null = null;
  const adminClient = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

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

    const payload = validatePayload(await request.json());

    // Validate every tenant input before creating an Auth account or sending email.
    const [{ data: slugState, error: slugError }, { data: activePlan, error: planError }] = await Promise.all([
      callerClient.rpc('rpc_validate_organization_slug', { p_slug: payload.slug }),
      adminClient.from('saas_plans').select('id').eq('id', payload.planId).eq('is_active', true).maybeSingle(),
    ]);
    if (slugError) throw slugError;
    if (!slugState?.available) {
      throw new Error(slugState?.reserved
        ? 'Tên miền con đã được hệ thống giữ lại.'
        : 'Tên miền con đã được sử dụng. Vui lòng chọn tên khác.');
    }
    if (planError) throw planError;
    if (!activePlan) throw new Error('Gói dịch vụ không còn hoạt động. Vui lòng tải lại danh sách gói.');

    const { data: usernameProfiles, error: profileLookupError } = await adminClient
      .from('profiles')
      .select('id,auth_user_id,username,display_name,is_external,is_active')
      .ilike('username', payload.email)
      .limit(2);
    if (profileLookupError) throw profileLookupError;
    if ((usernameProfiles || []).length > 1) {
      throw new Error('Email Owner đang trùng nhiều hồ sơ. Cần hợp nhất hồ sơ trước khi tạo workspace.');
    }
    const usernameProfile = (usernameProfiles || [])[0] as ProfileSnapshot | undefined;

    let matchedAuthUserId = '';
    for (let page = 1; page <= 50 && !matchedAuthUserId; page += 1) {
      const { data: usersPage, error: usersError } = await adminClient.auth.admin.listUsers({ page, perPage: 1000 });
      if (usersError) throw usersError;
      matchedAuthUserId = usersPage.users.find(user => String(user.email || '').toLowerCase() === payload.email)?.id || '';
      if (usersPage.users.length < 1000) break;
    }
    if (usernameProfile?.auth_user_id && matchedAuthUserId
      && usernameProfile.auth_user_id !== matchedAuthUserId) {
      throw new Error('Email Owner đang được liên kết với một tài khoản Auth khác.');
    }

    let ownerAuthUserId = matchedAuthUserId || String(usernameProfile?.auth_user_id || '');
    let invitationSent = false;
    if (!ownerAuthUserId) {
      const { data: invited, error: inviteError } = await adminClient.auth.admin.inviteUserByEmail(payload.email, {
        data: { display_name: payload.displayName },
        redirectTo: appUrl,
      });
      if (inviteError || !invited.user) throw inviteError || new Error('Không thể gửi email mời Owner.');
      ownerAuthUserId = invited.user.id;
      createdAuthUserId = invited.user.id;
      invitationSent = true;
    }

    const { data: platformStaff, error: staffError } = await adminClient
      .from('platform_staff').select('auth_user_id')
      .eq('auth_user_id', ownerAuthUserId).eq('is_active', true).maybeSingle();
    if (staffError) throw staffError;
    if (platformStaff) throw new Error('Tài khoản quản trị nền tảng không thể đồng thời làm Owner khách hàng.');

    const { data: authProfiles, error: authProfileError } = await adminClient
      .from('profiles')
      .select('id,auth_user_id,username,display_name,is_external,is_active')
      .eq('auth_user_id', ownerAuthUserId)
      .limit(2);
    if (authProfileError) throw authProfileError;
    if ((authProfiles || []).length > 1) throw new Error('Tài khoản Owner đang có nhiều hồ sơ ứng dụng.');
    const authProfile = (authProfiles || [])[0] as ProfileSnapshot | undefined;
    if (usernameProfile && authProfile && usernameProfile.id !== authProfile.id) {
      throw new Error('Email Owner và tài khoản Auth đang thuộc hai hồ sơ khác nhau.');
    }

    const profile = authProfile || usernameProfile;
    if (profile) {
      profileRollback = { mode: 'restore', snapshot: profile };
      const { error: profileUpdateError } = await adminClient.from('profiles').update({
        auth_user_id: ownerAuthUserId,
        username: payload.email,
        display_name: payload.displayName,
        is_external: false,
        is_active: true,
        updated_at: new Date().toISOString(),
      }).eq('id', profile.id);
      if (profileUpdateError) throw profileUpdateError;
    } else {
      const { data: insertedProfile, error: profileInsertError } = await adminClient.from('profiles').insert({
        id: ownerAuthUserId,
        auth_user_id: ownerAuthUserId,
        username: payload.email,
        display_name: payload.displayName,
        role: 'sale',
        is_external: false,
        is_active: true,
      }).select('id').single();
      if (profileInsertError || !insertedProfile) {
        throw profileInsertError || new Error('Không thể tạo hồ sơ ứng dụng cho Owner.');
      }
      profileRollback = { mode: 'delete', id: insertedProfile.id };
    }

    const { data: organization, error: provisionError } = await callerClient
      .rpc('rpc_platform_provision_customer', {
        p_owner_auth_user_id: ownerAuthUserId,
        p_name: payload.name,
        p_slug: payload.slug,
        p_plan_id: payload.planId,
        p_trial_days: payload.trialDays,
        p_business_type: payload.businessType,
        p_industry_key: payload.industryKey,
      });
    if (provisionError) throw provisionError;
    if (!organization?.organizationId || !organization?.ownerMembershipId) {
      throw new Error('Máy chủ không trả về đầy đủ kết quả khởi tạo workspace.');
    }

    profileRollback = null;
    return jsonResponse({
      organization,
      owner: { email: payload.email, displayName: payload.displayName },
      existingAccount: !invitationSent,
      invitationSent,
    }, 201);
  } catch (error) {
    const rollbackErrors: unknown[] = [];
    if (profileRollback?.mode === 'restore') {
      const snapshot = profileRollback.snapshot;
      const { error: restoreError } = await adminClient.from('profiles').update({
        auth_user_id: snapshot.auth_user_id,
        username: snapshot.username,
        display_name: snapshot.display_name,
        is_external: snapshot.is_external,
        is_active: snapshot.is_active,
        updated_at: new Date().toISOString(),
      }).eq('id', snapshot.id);
      if (restoreError) rollbackErrors.push(restoreError);
    } else if (profileRollback?.mode === 'delete') {
      const { error: profileDeleteError } = await adminClient.from('profiles').delete().eq('id', profileRollback.id);
      if (profileDeleteError) rollbackErrors.push(profileDeleteError);
    }
    if (createdAuthUserId) {
      // profiles.auth_user_id is ON DELETE RESTRICT, so the generated profile must go first.
      const { error: profileDeleteError } = await adminClient.from('profiles').delete().eq('auth_user_id', createdAuthUserId);
      if (profileDeleteError) rollbackErrors.push(profileDeleteError);
      const { error: authDeleteError } = await adminClient.auth.admin.deleteUser(createdAuthUserId);
      if (authDeleteError) rollbackErrors.push(authDeleteError);
    }
    console.error('platform-create-customer failed', { error, rollbackErrors });
    return jsonResponse({ error: getErrorMessage(error) }, 400);
  }
});
