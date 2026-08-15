# P0 profile/Auth staging recovery

This procedure is staging-only. It does not authorize a production change and
does not infer an administrator from an email address or username.

## 1. Backup and restore staging

Follow `P0_BACKUP_AND_STAGING.md`. Work against a restored staging clone and
confirm `$env:P0_STAGING_DATABASE_URL` does not reference production.

## 2. Apply migrations in order

Apply `0001` through `0005` with `psql -v ON_ERROR_STOP=1`. Migration `0005`
adds and validates the Auth foreign key, verifies uniqueness/roles, restores
the self-read policy, and installs the caller-scoped link-status probe.

If a staging clone previously ran an earlier development copy of `0002` that
linked legacy profiles by matching email/username, discard that clone and
restore it again from the untouched backup. The canonical `0002` preserves
legacy roles but leaves their `auth_user_id` null until this manual bootstrap.

## 3. Run the read-only diagnostic

```powershell
psql $env:P0_STAGING_DATABASE_URL -v ON_ERROR_STOP=1 `
  -f .\scripts\p0-diagnose-auth-profiles.sql `
  -o .\p0-auth-profile-diagnostic.txt
```

Review unmatched Auth users, unlinked legacy profiles, duplicates, invalid
roles, constraints, and the `profiles_select` policy. Do not continue while the
target email/profile is ambiguous.

## 4. Link only, without granting admin

When using Supabase SQL Editor instead of `psql`, open
`scripts/p0-bootstrap-admin-staging-sql-editor.sql`, edit only the four values
in `p0_bootstrap_input`, keep `grant_admin_confirmation` as `NO`, and run the
whole script. Confirm `rows_updated = 1` on the first run and `0` on a repeated
run. The same uniqueness, conflict, transaction, and audit checks apply.

```powershell
$adminEmail = Read-Host 'Existing staging Supabase Auth email'
$legacyProfile = Read-Host 'Exact legacy profile id or username'

psql $env:P0_STAGING_DATABASE_URL -v ON_ERROR_STOP=1 `
  -v environment_confirmation=STAGING_ONLY `
  -v admin_email="$adminEmail" `
  -v legacy_profile_key="$legacyProfile" `
  -v grant_admin_confirmation=NO `
  -f .\scripts\p0-bootstrap-admin-staging.sql
```

This preserves the profile's current role and active state. The transaction
stops unless both the Auth user and profile are unique and neither side is
linked elsewhere.

## 5. Explicit staging admin grant

Only after an authorized reviewer confirms that the selected legacy profile
must be an administrator:

For Supabase SQL Editor, change only `grant_admin_confirmation` in the editor
script to `I_UNDERSTAND_GRANT_ADMIN`. Do not infer this authorization from the
email address or from the legacy username.

```powershell
psql $env:P0_STAGING_DATABASE_URL -v ON_ERROR_STOP=1 `
  -v environment_confirmation=STAGING_ONLY `
  -v admin_email="$adminEmail" `
  -v legacy_profile_key="$legacyProfile" `
  -v grant_admin_confirmation=I_UNDERSTAND_GRANT_ADMIN `
  -f .\scripts\p0-bootstrap-admin-staging.sql
```

Expected first-run output is exactly one updated profile. Running the identical
command a second time must return `rows_updated = 0`; it must not create a new
profile, relink another profile, or add another bootstrap audit event.

## 6. Verify

```powershell
psql $env:P0_STAGING_DATABASE_URL -v ON_ERROR_STOP=1 `
  -f .\migrations\tests\p0_security_integration.sql

psql $env:P0_STAGING_DATABASE_URL -v ON_ERROR_STOP=1 `
  -f .\migrations\tests\p0_profile_auth_integration.sql
```

Then exercise frontend login with valid, missing-link, locked, and valid-role
test accounts. Browser storage edits must not change the database-derived role.

## 7. Rollback

On any unexpected result, stop using the staging project and restore the full
pre-change dump with the matching frontend. Do not drop the foreign key, unique
constraint, role check, or RLS policy to make login succeed.
