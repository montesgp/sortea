# ADR 0001: Tenancy resolved by hostname, isolated by row level security

Status: accepted, 2026-10-14

## Context

Every organization must be unable to read, change or subscribe to another organization's data (FR-ORG-04, AC-02). A missing `where organization_id = …` in one query must not become a data leak.

## Decision

- Tables live in a private `app` schema that Supabase's REST API does not expose; `anon`, `authenticated` and `service_role` have no grants on it.
- Every business table carries `organization_id`. Migration `0001_tenant_rls.sql` enables RLS and applies one policy to all of them: rows are visible and writable only when `organization_id = app.current_organization_id()`.
- The API connects as the schema owner, but `withTenant(orgId, fn)` runs each request in a transaction that pins `app.organization_id` and switches to the `sortea_app` role (no `BYPASSRLS`). With no organization pinned, the role sees nothing.
- `withPlatform` keeps owner access for the few cross-tenant paths: hostname resolution, platform console, outbox claiming. Call sites are named and few.
- The tenant comes from the request hostname, forwarded by the web tier with an internal token. No public endpoint accepts an organization id from the browser. Webhooks name the organization in the path, but a wrong id simply fails that organization's signature check.
- A test fails if any table with `organization_id` lacks RLS or its policy.

## Consequences

- New tables need `app.apply_tenant_policy('<table>')` in their migration.
- Supabase Realtime cannot read the `app` schema directly; the realtime phase will publish curated events instead of table changes.
