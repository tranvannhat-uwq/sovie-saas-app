import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders={
  'Access-Control-Allow-Origin':'*',
  'Access-Control-Allow-Headers':'authorization, x-client-info, apikey, content-type',
};
function jsonResponse(body:unknown,status=200){return new Response(JSON.stringify(body),{
  status,headers:{...corsHeaders,'Content-Type':'application/json'},
});}
function hex(bytes:ArrayBuffer){return [...new Uint8Array(bytes)].map(v=>v.toString(16).padStart(2,'0')).join('');}

Deno.serve(async request=>{
  if(request.method==='OPTIONS')return new Response('ok',{headers:corsHeaders});
  if(request.method!=='POST')return jsonResponse({error:'Method not allowed.'},405);
  const supabaseUrl=Deno.env.get('SUPABASE_URL');
  const anonKey=Deno.env.get('SUPABASE_ANON_KEY');
  const serviceRoleKey=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const apiToken=Deno.env.get('CLOUDFLARE_API_TOKEN');
  const zoneId=Deno.env.get('CLOUDFLARE_ZONE_ID');
  const originHostname=Deno.env.get('CLOUDFLARE_ORIGIN_HOSTNAME');
  const cnameTarget=Deno.env.get('CLOUDFLARE_CNAME_TARGET');
  const authorization=request.headers.get('Authorization');
  if(!supabaseUrl||!anonKey||!serviceRoleKey)return jsonResponse({error:'Function chưa được cấu hình.'},500);
  if(!authorization?.startsWith('Bearer '))return jsonResponse({error:'Bạn cần đăng nhập lại.'},401);
  if(!apiToken||!zoneId||!originHostname||!cnameTarget){
    return jsonResponse({error:'Cloudflare for SaaS chưa được cấu hình.'},503);
  }

  const caller=createClient(supabaseUrl,anonKey,{
    global:{headers:{Authorization:authorization}},auth:{persistSession:false,autoRefreshToken:false},
  });
  const {data:authData,error:authError}=await caller.auth.getUser();
  if(authError||!authData.user)return jsonResponse({error:'Phiên đăng nhập không hợp lệ.'},401);
  let jobId='';
  try{
    const payload=await request.json();
    const domainId=String(payload?.domainId||'').trim();
    if(!domainId)return jsonResponse({error:'Thiếu domainId.'},400);
    const {data:job,error:beginError}=await caller.rpc('rpc_begin_domain_ssl_provisioning',{p_domain_id:domainId});
    if(beginError||!job?.jobId)return jsonResponse({error:beginError?.message||'Không thể bắt đầu cấp SSL.'},400);
    jobId=String(job.jobId);
    const operation=String(job.operation||'create');
    const providerId=String(job.providerHostnameId||'');
    const endpoint=operation==='sync'
      ? `https://api.cloudflare.com/client/v4/zones/${zoneId}/custom_hostnames/${encodeURIComponent(providerId)}`
      : `https://api.cloudflare.com/client/v4/zones/${zoneId}/custom_hostnames`;
    const cloudflareResponse=await fetch(endpoint,{
      method:operation==='sync'?'GET':'POST',
      headers:{Authorization:`Bearer ${apiToken}`,'Content-Type':'application/json'},
      body:operation==='sync'?undefined:JSON.stringify({
        hostname:job.hostname,custom_origin_server:originHostname,
        ssl:{method:'http',type:'dv',settings:{min_tls_version:'1.2'}},
        custom_metadata:{organization_id:String(job.organizationId||''),domain_id:domainId},
      }),
      signal:AbortSignal.timeout(12000),
    });
    const cloudflarePayload=await cloudflareResponse.json();
    if(!cloudflareResponse.ok||cloudflarePayload?.success!==true){
      const message=String(cloudflarePayload?.errors?.[0]?.message||`Cloudflare HTTP ${cloudflareResponse.status}`);
      throw new Error(message);
    }
    const result=cloudflarePayload.result||{};
    const rawEvidence=JSON.stringify({id:result.id,status:result.status,sslStatus:result.ssl?.status});
    const evidenceHash=hex(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(rawEvidence)));
    const admin=createClient(supabaseUrl,serviceRoleKey,{auth:{persistSession:false,autoRefreshToken:false}});
    const eventKey=`cloudflare:${jobId}:${String(result.modified_at||result.created_at||Date.now())}`;
    const {data:finish,error:finishError}=await admin.rpc('rpc_finish_domain_ssl_provisioning',{
      p_job_id:jobId,p_event_key:eventKey,p_provider_hostname_id:result.id||providerId,
      p_hostname_status:result.status||'pending',p_ssl_status:result.ssl?.status||'pending',
      p_evidence_hash:evidenceHash,p_error_message:null,
    });
    if(finishError)throw finishError;
    return jsonResponse({ready:finish?.ready===true,hostname:job.hostname,cnameTarget,
      hostnameStatus:result.status,sslStatus:result.ssl?.status,result:finish});
  }catch(error){
    if(jobId&&supabaseUrl&&serviceRoleKey){
      const admin=createClient(supabaseUrl,serviceRoleKey,{auth:{persistSession:false,autoRefreshToken:false}});
      await admin.rpc('rpc_finish_domain_ssl_provisioning',{
        p_job_id:jobId,p_event_key:`cloudflare-error:${jobId}`,p_provider_hostname_id:null,
        p_hostname_status:null,p_ssl_status:null,p_evidence_hash:null,
        p_error_message:error instanceof Error?error.message:'Cloudflare provisioning failed',
      });
    }
    return jsonResponse({error:error instanceof Error?error.message:'Không thể cấp SSL.'},400);
  }
});
