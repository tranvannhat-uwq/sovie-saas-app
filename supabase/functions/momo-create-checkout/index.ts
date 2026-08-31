import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const encoder = new TextEncoder();
function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}
function hex(bytes: ArrayBuffer) {
  return [...new Uint8Array(bytes)].map(value => value.toString(16).padStart(2, '0')).join('');
}
function safeEqual(left: string, right: string) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}
async function hmac(secret: string, raw: string) {
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  return hex(await crypto.subtle.sign('HMAC', key, encoder.encode(raw)));
}

Deno.serve(async request => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (request.method !== 'POST') return jsonResponse({ error: 'Method not allowed.' }, 405);

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const partnerCode = String(Deno.env.get('MOMO_PARTNER_CODE') || '');
  const accessKey = String(Deno.env.get('MOMO_ACCESS_KEY') || '');
  const secretKey = String(Deno.env.get('MOMO_SECRET_KEY') || '');
  const redirectUrl = String(Deno.env.get('MOMO_REDIRECT_URL') || '');
  const ipnUrl = String(Deno.env.get('MOMO_IPN_URL') || '');
  const apiBase = String(Deno.env.get('MOMO_API_BASE') || 'https://test-payment.momo.vn').replace(/\/$/, '');
  const authorization = request.headers.get('Authorization');
  if (!supabaseUrl || !anonKey || !serviceRoleKey || !partnerCode || !accessKey || !secretKey) {
    return jsonResponse({ error: 'Thông tin kết nối MoMo chưa được cấu hình.' }, 503);
  }
  if (!['https://test-payment.momo.vn', 'https://payment.momo.vn'].includes(apiBase)
    || !redirectUrl.startsWith('https://') || !ipnUrl.startsWith('https://')) {
    return jsonResponse({ error: 'URL MoMo hoặc URL callback không hợp lệ.' }, 503);
  }
  if (!authorization?.startsWith('Bearer ')) return jsonResponse({ error: 'Bạn cần đăng nhập lại.' }, 401);

  try {
    const caller = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authorization } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: authData, error: authError } = await caller.auth.getUser();
    if (authError || !authData.user) return jsonResponse({ error: 'Phiên đăng nhập không hợp lệ.' }, 401);
    const payload = await request.json();
    const requestId = String(payload?.requestId || '').trim();
    if (!/^[0-9a-f-]{36}$/i.test(requestId)) return jsonResponse({ error: 'Thiếu mã yêu cầu thanh toán.' }, 400);

    const { data: checkout, error: prepareError } = await caller.rpc('rpc_prepare_my_momo_checkout', {
      p_request_id: requestId,
    });
    if (prepareError || !checkout?.orderId) {
      return jsonResponse({ error: prepareError?.message || 'Không thể chuẩn bị thanh toán MoMo.' }, 400);
    }
    const amount = Number(checkout.total);
    if (!Number.isSafeInteger(amount) || amount < 1000 || amount > 50000000 || checkout.currency !== 'VND') {
      return jsonResponse({ error: 'Số tiền thanh toán MoMo không hợp lệ.' }, 400);
    }

    const orderId = String(checkout.orderId);
    const momoRequestId = requestId;
    const requestType = 'captureWallet';
    const extraData = btoa(JSON.stringify({ checkoutRequestId: requestId }));
    const orderInfo = `SoVie ${checkout.planName} ${checkout.billingCycle === 'yearly' ? '12 thang' : '1 thang'}`;
    const rawSignature = `accessKey=${accessKey}&amount=${amount}&extraData=${extraData}`
      + `&ipnUrl=${ipnUrl}&orderId=${orderId}&orderInfo=${orderInfo}`
      + `&partnerCode=${partnerCode}&redirectUrl=${redirectUrl}`
      + `&requestId=${momoRequestId}&requestType=${requestType}`;
    const signature = await hmac(secretKey, rawSignature);
    const momoBody = {
      partnerCode,
      partnerName: 'SoVie',
      storeId: 'SoVie',
      requestId: momoRequestId,
      amount,
      orderId,
      orderInfo,
      redirectUrl,
      ipnUrl,
      requestType,
      extraData,
      autoCapture: true,
      lang: 'vi',
      signature,
      items: [{
        id: checkout.planId,
        name: `Goi SoVie ${checkout.planName}`,
        description: orderInfo,
        category: 'software_service',
        price: Number(checkout.subtotal),
        currency: 'VND',
        quantity: 1,
        unit: checkout.billingCycle === 'yearly' ? 'nam' : 'thang',
        totalPrice: Number(checkout.subtotal),
        taxAmount: Number(checkout.tax),
      }],
      userInfo: {
        email: authData.user.email || '',
        name: String(authData.user.user_metadata?.display_name || authData.user.email || 'SoVie Owner'),
      },
    };
    const momoResponse = await fetch(`${apiBase}/v2/gateway/api/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(momoBody),
      signal: AbortSignal.timeout(20000),
    });
    const momoResult = await momoResponse.json();
    const resultCode = Number(momoResult?.resultCode);
    const responseRaw = `accessKey=${accessKey}&amount=${String(momoResult?.amount ?? '')}`
      + `&orderId=${String(momoResult?.orderId ?? '')}&partnerCode=${String(momoResult?.partnerCode ?? '')}`
      + `&payUrl=${String(momoResult?.payUrl ?? '')}&requestId=${String(momoResult?.requestId ?? '')}`
      + `&responseTime=${String(momoResult?.responseTime ?? '')}&resultCode=${String(momoResult?.resultCode ?? '')}`;
    const expectedResponseSignature = await hmac(secretKey, responseRaw);
    if (!momoResponse.ok || !Number.isInteger(resultCode)
      || !safeEqual(String(momoResult?.signature || '').toLowerCase(), expectedResponseSignature)
      || momoResult?.partnerCode !== partnerCode || momoResult?.orderId !== orderId
      || Number(momoResult?.amount) !== amount) {
      return jsonResponse({ error: 'Phản hồi từ MoMo không hợp lệ hoặc không khớp yêu cầu.' }, 502);
    }

    const admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { error: recordError } = await admin.rpc('rpc_record_momo_checkout_response', {
      p_request_id: requestId,
      p_order_id: orderId,
      p_result_code: resultCode,
      p_pay_url: momoResult?.payUrl || null,
    });
    if (recordError) return jsonResponse({ error: recordError.message }, 500);
    if (resultCode !== 0 || !momoResult?.payUrl) {
      return jsonResponse({ error: momoResult?.message || 'MoMo từ chối tạo giao dịch.', resultCode }, 400);
    }
    return jsonResponse({
      requestId, orderId, amount, subtotal: checkout.subtotal, tax: checkout.tax,
      payUrl: momoResult.payUrl, deeplink: momoResult.deeplink || null,
      qrCodeUrl: momoResult.qrCodeUrl || null,
    });
  } catch (error) {
    return jsonResponse({ error: error instanceof Error ? error.message : 'Không thể kết nối MoMo.' }, 500);
  }
});
