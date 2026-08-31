import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}
function normalizeTxt(value: string) {
  return value.replace(/^"|"$/g, '').replace(/"\s+"/g, '').trim();
}

Deno.serve(async request => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (request.method !== 'POST') return jsonResponse({ error: 'Method not allowed.' }, 405);
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const authorization = request.headers.get('Authorization');
  if (!supabaseUrl || !anonKey || !serviceRoleKey) return jsonResponse({ error: 'Function chưa được cấu hình.' }, 500);
  if (!authorization?.startsWith('Bearer ')) return jsonResponse({ error: 'Bạn cần đăng nhập lại.' }, 401);

  const caller = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: authData, error: authError } = await caller.auth.getUser();
  if (authError || !authData.user) return jsonResponse({ error: 'Phiên đăng nhập không hợp lệ.' }, 401);

  let attemptId = '';
  try {
    const payload = await request.json();
    const domainId = String(payload?.domainId || '').trim();
    if (!domainId) return jsonResponse({ error: 'Thiếu domainId.' }, 400);
    const { data: attempt, error: beginError } = await caller.rpc('rpc_begin_domain_dns_verification', {
      p_domain_id: domainId,
    });
    if (beginError || !attempt?.attemptId) return jsonResponse({ error: beginError?.message || 'Không thể bắt đầu xác minh.' }, 400);
    attemptId = String(attempt.attemptId);
    const verification = attempt.verification || {};
    const dnsName = String(verification.name || '');
    const expectedValue = String(verification.value || '');
    const dnsResponse = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(dnsName)}&type=TXT`, {
      headers: { Accept: 'application/dns-json' },
      signal: AbortSignal.timeout(8000),
    });
    if (!dnsResponse.ok) throw new Error(`DNS resolver trả về HTTP ${dnsResponse.status}`);
    const dnsPayload = await dnsResponse.json();
    const answers = Array.isArray(dnsPayload?.Answer) ? dnsPayload.Answer : [];
    const values = answers.filter((answer: { type?: number }) => answer?.type === 16)
      .map((answer: { data?: string }) => normalizeTxt(String(answer?.data || '')));
    const verified = values.some((value: string) => value === expectedValue);
    const evidenceSource = JSON.stringify({ name: dnsName, values });
    const evidenceHash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(evidenceSource)))]
      .map(value => value.toString(16).padStart(2, '0')).join('');
    const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data: result, error: finishError } = await admin.rpc('rpc_finish_domain_dns_verification', {
      p_attempt_id: attemptId, p_verified: verified, p_evidence_hash: evidenceHash, p_error: false,
    });
    if (finishError) throw finishError;
    return jsonResponse({ verified, hostname: attempt.hostname, result });
  } catch (error) {
    if (attemptId && supabaseUrl && serviceRoleKey) {
      const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
      await admin.rpc('rpc_finish_domain_dns_verification', {
        p_attempt_id: attemptId, p_verified: false, p_evidence_hash: null, p_error: true,
      });
    }
    return jsonResponse({ error: error instanceof Error ? error.message : 'Không thể kiểm tra DNS.' }, 400);
  }
});
