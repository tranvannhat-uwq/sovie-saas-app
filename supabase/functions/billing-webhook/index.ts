import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const jsonHeaders = { 'Content-Type': 'application/json' };
const encoder = new TextEncoder();

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: jsonHeaders });
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

async function verifySignature(secret: string, timestamp: string, rawBody: string, supplied: string) {
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const digest = await crypto.subtle.sign('HMAC', key, encoder.encode(`${timestamp}.${rawBody}`));
  return safeEqual(`v1=${hex(digest)}`, supplied.toLowerCase());
}

Deno.serve(async request => {
  if (request.method !== 'POST') return jsonResponse({ error: 'Method not allowed.' }, 405);
  const secret = Deno.env.get('BILLING_WEBHOOK_SECRET');
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!secret || !supabaseUrl || !serviceRoleKey) {
    return jsonResponse({ error: 'Billing webhook chưa được cấu hình.' }, 503);
  }

  const timestamp = String(request.headers.get('x-sovie-timestamp') || '');
  const signature = String(request.headers.get('x-sovie-signature') || '');
  const unixSeconds = Number(timestamp);
  if (!/^\d{10}$/.test(timestamp) || !/^v1=[a-f0-9]{64}$/i.test(signature)
    || Math.abs(Date.now() / 1000 - unixSeconds) > 300) {
    return jsonResponse({ error: 'Webhook timestamp hoặc signature không hợp lệ.' }, 401);
  }

  const rawBody = await request.text();
  if (!await verifySignature(secret, timestamp, rawBody, signature)) {
    return jsonResponse({ error: 'Webhook signature không hợp lệ.' }, 401);
  }

  try {
    const payload = JSON.parse(rawBody);
    const eventId = String(payload?.eventId || '').trim();
    const occurredAt = new Date(payload?.occurredAt || unixSeconds * 1000);
    const organizationId = String(payload?.organizationId || '').trim();
    const provider = String(payload?.provider || '').trim().toLowerCase();
    const eventType = String(payload?.type || '').trim().toLowerCase();
    const planId = String(payload?.planId || '').trim();
    if (!eventId || !organizationId || !planId || Number.isNaN(occurredAt.getTime())) {
      return jsonResponse({ error: 'Payload billing thiếu trường bắt buộc.' }, 400);
    }

    const payloadHash = hex(await crypto.subtle.digest('SHA-256', encoder.encode(rawBody)));
    const admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data, error } = await admin.rpc('rpc_apply_signed_billing_event', {
      p_event_key: eventId,
      p_occurred_at: occurredAt.toISOString(),
      p_organization_id: organizationId,
      p_provider: provider,
      p_event_type: eventType,
      p_plan_id: planId,
      p_provider_invoice_id: payload?.invoice?.id || null,
      p_invoice_number: payload?.invoice?.number || null,
      p_total: Number(payload?.invoice?.total || 0),
      p_currency: payload?.invoice?.currency || 'VND',
      p_period_start: payload?.period?.start || null,
      p_period_end: payload?.period?.end || null,
      p_request_id: payload?.checkoutRequestId || null,
      p_hosted_invoice_url: payload?.invoice?.url || null,
      p_payload_hash: payloadHash,
      p_signature_version: 'v1',
    });
    if (error) return jsonResponse({ error: error.message }, 400);
    return jsonResponse({ received: true, result: data });
  } catch (error) {
    return jsonResponse({ error: error instanceof Error ? error.message : 'Payload JSON không hợp lệ.' }, 400);
  }
});
