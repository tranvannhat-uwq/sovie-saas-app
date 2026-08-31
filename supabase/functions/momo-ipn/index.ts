import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const encoder = new TextEncoder();
function hex(bytes: ArrayBuffer) {
  return [...new Uint8Array(bytes)].map(value => value.toString(16).padStart(2, '0')).join('');
}
function safeEqual(left: string, right: string) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}
async function hmac(secret: string, raw: string) {
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  return hex(await crypto.subtle.sign('HMAC', key, encoder.encode(raw)));
}
function jsonError(message: string, status: number) {
  return new Response(JSON.stringify({ error: message }), {
    status, headers: { 'Content-Type': 'application/json' },
  });
}

Deno.serve(async request => {
  if (request.method !== 'POST') return jsonError('Method not allowed.', 405);
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const partnerCode = String(Deno.env.get('MOMO_PARTNER_CODE') || '');
  const accessKey = String(Deno.env.get('MOMO_ACCESS_KEY') || '');
  const secretKey = String(Deno.env.get('MOMO_SECRET_KEY') || '');
  if (!supabaseUrl || !serviceRoleKey || !partnerCode || !accessKey || !secretKey) {
    return jsonError('MoMo IPN chưa được cấu hình.', 503);
  }
  const rawBody = await request.text();
  try {
    const payload = JSON.parse(rawBody);
    const suppliedSignature = String(payload?.signature || '').toLowerCase();
    const rawSignature = `accessKey=${accessKey}&amount=${String(payload?.amount ?? '')}`
      + `&extraData=${String(payload?.extraData ?? '')}&message=${String(payload?.message ?? '')}`
      + `&orderId=${String(payload?.orderId ?? '')}&orderInfo=${String(payload?.orderInfo ?? '')}`
      + `&orderType=${String(payload?.orderType ?? '')}&partnerCode=${String(payload?.partnerCode ?? '')}`
      + `&payType=${String(payload?.payType ?? '')}&requestId=${String(payload?.requestId ?? '')}`
      + `&responseTime=${String(payload?.responseTime ?? '')}&resultCode=${String(payload?.resultCode ?? '')}`
      + `&transId=${String(payload?.transId ?? '')}`;
    const expectedSignature = await hmac(secretKey, rawSignature);
    if (!/^[a-f0-9]{64}$/.test(suppliedSignature)
      || !safeEqual(suppliedSignature, expectedSignature)
      || payload?.partnerCode !== partnerCode) {
      return jsonError('MoMo IPN signature không hợp lệ.', 401);
    }
    const orderId = String(payload?.orderId || '').trim();
    const amount = Number(payload?.amount);
    const resultCode = Number(payload?.resultCode);
    const responseTimeMs = Number(payload?.responseTime);
    if (!orderId || !Number.isSafeInteger(amount) || !Number.isInteger(resultCode)
      || !Number.isSafeInteger(responseTimeMs)) {
      return jsonError('MoMo IPN thiếu dữ liệu bắt buộc.', 400);
    }
    const payloadHash = hex(await crypto.subtle.digest('SHA-256', encoder.encode(rawBody)));
    const admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { error } = await admin.rpc('rpc_apply_momo_ipn', {
      p_order_id: orderId,
      p_amount: amount,
      p_result_code: resultCode,
      p_trans_id: String(payload?.transId ?? ''),
      p_response_time: new Date(responseTimeMs).toISOString(),
      p_payload_hash: payloadHash,
    });
    if (error) return jsonError(error.message, 400);
    return new Response(null, { status: 204 });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : 'MoMo IPN JSON không hợp lệ.', 400);
  }
});
