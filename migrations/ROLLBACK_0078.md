# Rollback migration 0078

Migration 0078 is additive and never deletes tenant business rows. To stop new
requests, revoke `EXECUTE` on `rpc_request_organization_archive(text,text,text)`
from `authenticated`; keep the request/audit table.

Do not automatically reactivate an organization already archived. Restoring
membership, domain and subscription access requires a separately reviewed
back-office procedure, verified backup evidence and an audit event.
