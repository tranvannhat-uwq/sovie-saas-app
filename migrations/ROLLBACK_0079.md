# Rollback migration 0079

Migration 0079 changes only column nullability after proving every business row
already has an organization. A frontend rollback is normally sufficient.

If schema rollback is required on staging, remove `NOT NULL` only from the
explicit 33-table list in the migration. Do not clear or rewrite any existing
`organization_id`, and do not apply the rollback to production without a
separate review.
