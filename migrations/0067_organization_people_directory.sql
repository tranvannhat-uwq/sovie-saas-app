BEGIN;

CREATE TABLE public.organization_people (
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  id text NOT NULL DEFAULT ('person_' || gen_random_uuid()::text),
  username text NOT NULL,
  display_name text NOT NULL,
  phone text,
  job_title text,
  company_id text,
  employment_type text NOT NULL DEFAULT 'employee',
  status text NOT NULL DEFAULT 'active',
  created_by uuid NOT NULL DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT organization_people_pkey PRIMARY KEY (organization_id, id),
  CONSTRAINT organization_people_username_length CHECK (char_length(btrim(username)) BETWEEN 2 AND 120),
  CONSTRAINT organization_people_display_name_length CHECK (char_length(btrim(display_name)) BETWEEN 2 AND 160),
  CONSTRAINT organization_people_employment_type_check
    CHECK (employment_type IN ('employee','contractor','external')),
  CONSTRAINT organization_people_status_check CHECK (status IN ('active','inactive'))
);

CREATE UNIQUE INDEX organization_people_tenant_username_uidx
  ON public.organization_people (organization_id, lower(username));
CREATE INDEX organization_people_tenant_status_idx
  ON public.organization_people (organization_id, status, display_name);

ALTER TABLE public.organization_people ENABLE ROW LEVEL SECURITY;
CREATE POLICY organization_people_tenant_select ON public.organization_people
FOR SELECT TO authenticated USING (
  organization_id = public.current_organization_id()
  AND public.has_organization_role(
    organization_id, ARRAY['owner','admin','accounting','sale']
  )
);

REVOKE ALL ON public.organization_people FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.organization_people TO authenticated;

CREATE OR REPLACE FUNCTION public.rpc_my_organization_people()
RETURNS TABLE (
  person_id text,
  username text,
  display_name text,
  phone text,
  job_title text,
  company_id text,
  employment_type text,
  status text,
  created_at timestamptz
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE active_organization_id uuid := public.current_organization_id();
BEGIN
  IF active_organization_id IS NULL THEN
    RAISE EXCEPTION '403: active organization membership required' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT person.id, person.username, person.display_name, person.phone,
    person.job_title, person.company_id, person.employment_type,
    person.status, person.created_at
  FROM public.organization_people person
  WHERE person.organization_id = active_organization_id
  ORDER BY person.status, person.display_name, person.username;
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_upsert_organization_person(
  p_person_id text DEFAULT NULL,
  p_username text DEFAULT NULL,
  p_display_name text DEFAULT NULL,
  p_phone text DEFAULT NULL,
  p_job_title text DEFAULT NULL,
  p_company_id text DEFAULT NULL,
  p_employment_type text DEFAULT 'employee',
  p_status text DEFAULT 'active'
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  active_organization_id uuid := public.current_organization_id();
  normalized_id text := NULLIF(btrim(COALESCE(p_person_id, '')), '');
  normalized_username text := lower(btrim(COALESCE(p_username, '')));
  normalized_display_name text := btrim(COALESCE(p_display_name, ''));
  normalized_employment_type text := lower(btrim(COALESCE(p_employment_type, 'employee')));
  normalized_status text := lower(btrim(COALESCE(p_status, 'active')));
  result public.organization_people%ROWTYPE;
BEGIN
  IF active_organization_id IS NULL
    OR NOT public.has_organization_role(active_organization_id, ARRAY['owner','admin']) THEN
    RAISE EXCEPTION '403: workspace owner or admin required' USING ERRCODE = '42501';
  END IF;
  IF char_length(normalized_username) NOT BETWEEN 2 AND 120 THEN
    RAISE EXCEPTION 'Personnel code must contain 2 to 120 characters' USING ERRCODE = '22023';
  END IF;
  IF char_length(normalized_display_name) NOT BETWEEN 2 AND 160 THEN
    RAISE EXCEPTION 'Personnel display name must contain 2 to 160 characters' USING ERRCODE = '22023';
  END IF;
  IF normalized_employment_type NOT IN ('employee','contractor','external') THEN
    RAISE EXCEPTION 'Unsupported employment type' USING ERRCODE = '22023';
  END IF;
  IF normalized_status NOT IN ('active','inactive') THEN
    RAISE EXCEPTION 'Unsupported personnel status' USING ERRCODE = '22023';
  END IF;

  IF normalized_id IS NULL THEN
    normalized_id := 'person_' || gen_random_uuid()::text;
    INSERT INTO public.organization_people (
      organization_id, id, username, display_name, phone, job_title,
      company_id, employment_type, status, created_by
    ) VALUES (
      active_organization_id, normalized_id, normalized_username,
      normalized_display_name, NULLIF(btrim(COALESCE(p_phone, '')), ''),
      NULLIF(btrim(COALESCE(p_job_title, '')), ''),
      NULLIF(btrim(COALESCE(p_company_id, '')), ''),
      normalized_employment_type, normalized_status, auth.uid()
    ) RETURNING * INTO result;
  ELSE
    UPDATE public.organization_people
    SET username = normalized_username,
        display_name = normalized_display_name,
        phone = NULLIF(btrim(COALESCE(p_phone, '')), ''),
        job_title = NULLIF(btrim(COALESCE(p_job_title, '')), ''),
        company_id = NULLIF(btrim(COALESCE(p_company_id, '')), ''),
        employment_type = normalized_employment_type,
        status = normalized_status,
        updated_at = now()
    WHERE organization_id = active_organization_id AND id = normalized_id
    RETURNING * INTO result;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Workspace personnel record not found' USING ERRCODE = 'P0002';
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'personId', result.id,
    'organizationId', result.organization_id,
    'username', result.username,
    'displayName', result.display_name,
    'status', result.status,
    'employmentType', result.employment_type
  );
END;
$$;

REVOKE ALL ON FUNCTION public.rpc_my_organization_people(),
  public.rpc_upsert_organization_person(text,text,text,text,text,text,text,text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_my_organization_people(),
  public.rpc_upsert_organization_person(text,text,text,text,text,text,text,text)
  TO authenticated;

INSERT INTO public.schema_migrations(version, description)
VALUES ('0067', 'Add tenant personnel directory independent from login accounts')
ON CONFLICT (version) DO NOTHING;

COMMIT;
