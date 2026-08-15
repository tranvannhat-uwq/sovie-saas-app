BEGIN;

CREATE OR REPLACE FUNCTION public.p37_log_draft_activity()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  actor public.profiles%ROWTYPE;
  old_row jsonb := CASE WHEN TG_OP='INSERT' THEN '{}'::jsonb ELSE to_jsonb(OLD) END;
  new_row jsonb := CASE WHEN TG_OP='DELETE' THEN '{}'::jsonb ELSE to_jsonb(NEW) END;
  source jsonb := CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
  diff jsonb;
  old_summary jsonb;
  new_summary jsonb;
  activity_action text;
BEGIN
  IF auth.uid() IS NULL THEN RETURN COALESCE(NEW,OLD); END IF;
  SELECT * INTO actor FROM public.profiles
  WHERE auth_user_id=auth.uid() AND is_active=true LIMIT 1;
  IF NOT FOUND THEN RETURN COALESCE(NEW,OLD); END IF;

  diff := public.p36_activity_changes(old_row,new_row);
  IF TG_OP='UPDATE' AND diff='{}'::jsonb THEN RETURN NEW; END IF;
  SELECT COALESCE(jsonb_object_agg(key,value->'old'),'{}'::jsonb),
         COALESCE(jsonb_object_agg(key,value->'new'),'{}'::jsonb)
  INTO old_summary,new_summary FROM jsonb_each(diff);
  activity_action := CASE WHEN TG_OP='INSERT' THEN 'create_draft_order'
    WHEN TG_OP='DELETE' THEN 'delete_draft_order'
    WHEN (SELECT count(*) FROM jsonb_object_keys(diff))=1 AND diff ? 'notes' THEN 'update_draft_order_notes'
    ELSE 'update_draft_order' END;

  INSERT INTO public.activity_logs(
    operation_key,actor_id,actor_profile_id,actor_username,actor_name,actor_role,
    action,module,target_type,target_id,target_name,order_id,customer_id,company_id,
    description,old_value,new_value,changes,metadata,created_at
  ) VALUES (
    txid_current()::text,actor.auth_user_id,actor.id,actor.username,actor.display_name,actor.role,
    activity_action,'orders','draft_order',source->>'id',COALESCE(source->>'customer_name',source->>'id'),
    source->>'id',source->>'customer_id',source->>'company_id',activity_action||':'||(source->>'id'),
    NULLIF(old_summary,'{}'::jsonb),NULLIF(new_summary,'{}'::jsonb),diff,
    jsonb_build_object('table','draft_orders','operation',TG_OP,'draft',true),now()
  )
  ON CONFLICT(operation_key,module,target_type,target_id) DO UPDATE SET
    action=EXCLUDED.action,new_value=COALESCE(EXCLUDED.new_value,public.activity_logs.new_value),
    changes=public.activity_logs.changes||EXCLUDED.changes,
    metadata=public.activity_logs.metadata||EXCLUDED.metadata;
  RETURN COALESCE(NEW,OLD);
END;
$$;

DROP TRIGGER IF EXISTS p37_draft_activity_row ON public.draft_orders;
CREATE TRIGGER p37_draft_activity_row
AFTER INSERT OR UPDATE OR DELETE ON public.draft_orders
FOR EACH ROW EXECUTE FUNCTION public.p37_log_draft_activity();

CREATE OR REPLACE FUNCTION public.rpc_update_draft_order_notes(p_draft_id text,p_notes text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE actor public.profiles%ROWTYPE; target public.draft_orders%ROWTYPE; normalized text := btrim(COALESCE(p_notes,''));
BEGIN
  actor := public.require_authenticated_profile();
  IF length(normalized)>2000 THEN RAISE EXCEPTION 'Draft notes cannot exceed 2000 characters'; END IF;
  SELECT * INTO STRICT target FROM public.draft_orders WHERE id=p_draft_id FOR UPDATE;
  IF actor.role='sale' AND NOT (target.created_by IN (actor.auth_user_id::text,actor.username)) THEN
    RAISE EXCEPTION '403: draft access denied' USING ERRCODE='42501';
  END IF;
  IF COALESCE(target.notes,'') IS NOT DISTINCT FROM normalized THEN
    RETURN jsonb_build_object('success',true,'unchanged',true,'order_id',target.id,'notes',normalized,'updated_at',target.updated_at);
  END IF;
  UPDATE public.draft_orders SET notes=normalized,updated_at=now(),updated_by=actor.auth_user_id::text WHERE id=target.id;
  RETURN jsonb_build_object('success',true,'unchanged',false,'order_id',target.id,'notes',normalized,'updated_at',now());
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_get_order_activity(p_order_id text,p_limit integer DEFAULT 50)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE actor public.profiles%ROWTYPE; result jsonb;
BEGIN
  actor := public.require_authenticated_profile();
  IF actor.role='sale' AND NOT (
    EXISTS (SELECT 1 FROM public.orders sale WHERE sale.id=p_order_id AND (
      sale.created_by=actor.auth_user_id::text OR sale.salesperson_id IN (actor.auth_user_id::text,actor.username)
      OR (sale.customer_id IS NOT NULL AND public.can_access_customer(sale.customer_id))))
    OR EXISTS (SELECT 1 FROM public.draft_orders draft WHERE draft.id=p_order_id AND draft.created_by IN (actor.auth_user_id::text,actor.username))
  ) THEN RAISE EXCEPTION '403: order activity access denied' USING ERRCODE='42501'; END IF;
  SELECT COALESCE(jsonb_agg(to_jsonb(log) ORDER BY log.created_at DESC,log.id DESC),'[]'::jsonb) INTO result
  FROM (SELECT * FROM public.activity_logs WHERE order_id=p_order_id ORDER BY created_at DESC,id DESC LIMIT LEAST(GREATEST(COALESCE(p_limit,50),1),100)) log;
  RETURN result;
END;
$$;

REVOKE ALL ON FUNCTION public.p37_log_draft_activity() FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.rpc_update_draft_order_notes(text,text),public.rpc_get_order_activity(text,integer) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.rpc_update_draft_order_notes(text,text),public.rpc_get_order_activity(text,integer) TO authenticated;

INSERT INTO public.schema_migrations(version,description)
VALUES ('0037','Track draft-order activity and update draft notes through the correct table')
ON CONFLICT(version) DO NOTHING;
COMMIT;
