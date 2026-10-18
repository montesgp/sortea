# ADR 0011: Organizations are erased only by an operator command, on explicit request

Status: accepted, 2026-10-17

## Context

The owner may need to remove an organization entirely, for example a test tenant or a client who asks for it, but only when they explicitly ask for it. Nothing in the platform deletes organizations today. ADR 0010 keeps buyer data for the life of the organization, and several tables are append-only by design: triggers refuse updates and deletes on `audit_events`, `payment_events`, `entry_ledger_events`, `draw_events`, `contact_consents`, `participation_entries`, `campaign_rule_versions`, `draw_manifests`, `payment_settlements` and `cms_block_revisions` (migrations 0001, 0003, 0004, 0006). Every `organization_id` foreign key is `restrict`. Files sit in the Supabase buckets under `<organizationId>/`.

## Decision

- **Operator CLI only.** `pnpm db:erase-org <slug>` runs with `DATABASE_URL` (the owner connection used by migrations and the seed, not the app role). There is no UI or API endpoint, and nothing runs it on a schedule.
- **Dry run by default.** Without `--confirm`, the command prints the database host, the organization's name, slug and id, its rows per table and its files per bucket, and deletes nothing.
- **Exact confirmation.** It erases only with `--confirm <slug>`, and the value must equal the slug exactly.
- **Production guard.** An organization with a Mercado Pago integration in `production` mode is refused unless `--allow-production` is also given. The check repeats under a lock on the organization row.
- **One transaction.** The tables to clear are found in the catalog: every table in schema `app` with an `organization_id` column, so new tables are covered without code changes. Inside the transaction, `SET LOCAL session_replication_role = replica` skips the append-only triggers and foreign key checks while the organization's rows are deleted. Normal mode then returns, still inside the transaction, and the command checks that no row with that `organization_id` remains and that no foreign key points to a deleted row. Only then does it delete the organization row, with foreign keys enforced again. Any failed check rolls everything back. Outside this transaction, the append-only protection is unchanged.
- **Accounts stay.** Only `organization_members` rows are removed. `auth.users` is not touched, because a member may belong to other organizations.
- **Storage after the commit.** The files under `<organizationId>/` are deleted through the Supabase Storage API (`SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `STORAGE_BUCKET`, `MEDIA_BUCKET`), listing them again after the commit so late uploads go too. Without those credentials the command refuses to erase, since the files would stay, unless `--skip-storage` makes that choice explicit; a dry run then only warns. A failed bucket is reported, and the command exits non-zero, so its files can be removed by hand.
- **Platform audit record.** The same transaction writes one `audit_events` row with `organization_id` null, `actor_type` `operator`, `action` `organization.erased`, `target_type` `organization`, `target_id` the id and metadata `{ slug, name, counts, storageCounts }`, never secrets.

## Consequences

- Erasure is irreversible. Backups are the only recovery, so check that a recent backup exists before erasing in production.
- It is an exception to ADR 0010: the organization's buyer data, draw evidence and audit trail go with it, and only the platform record of the erasure remains. Use it only on the owner's explicit request, and never automate it.
- The `postgres` role must be allowed to set `session_replication_role`. It is allowed on the local Supabase stack (Postgres 17, non-superuser `postgres`). On a hosted project, check it with a dry run first. If the setting is refused, the transaction fails before anything is deleted.
