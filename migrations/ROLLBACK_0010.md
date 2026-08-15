# Recovery for migration 0010

Migration 0010 only adds `public.suppliers.updated_at` and records its version.
It does not delete or rewrite supplier, purchase, debt, payment or cashbook
rows.

Do not drop `updated_at` while the Phase 4 RPCs from migration 0009 are active,
because those functions require the column. Preferred recovery on staging is a
frontend rollback while retaining the compatibility column, or restoration of
the verified pre-0009 backup into a separate staging project.
