# Agent instructions

Read `docs/spec/PRD.md`, `docs/spec/ARCHITECTURE.md`, `docs/spec/SECURITY.md`, `docs/spec/DRAW-INTEGRITY.md`, `docs/spec/DESIGN.md` and `docs/adr/*` before coding. Requirement ids and acceptance criteria are the source of truth.

## Non-negotiables

- Never invent legal authorizations, permit numbers or PSP approvals, and never enable paid participations without the compliance gate. A person records each approval, either with its authority and reference or by the organization owner attesting the paper documentation (ADR 0015). Seed and demo data keep approvals `pending`.
- Business rules live in `packages/domain` and the API. The web tier is SSR plus a thin BFF; it never holds secrets or decides prices.
- Every new business table carries `organization_id` and gets `app.apply_tenant_policy('<table>')` in its migration. Tenant code uses `db.withTenant`; `withPlatform` is reserved for named cross-tenant paths.
- Do not hardcode MotoGarage (or any tenant) in shared code. Brand experiences are switched by CMS content.
- No secrets in code, fixtures or logs. Credentials go through the platform console and are sealed.
- Money is integer minor units. Timestamps are UTC and shown in the campaign or organization time zone.

## Workflow

- Strict TypeScript, Zod at boundaries, Drizzle migrations (`pnpm db:generate`, custom SQL for RLS and triggers).
- Tests with behavior, not implementation: Vitest against real Postgres for db/api/worker, Playwright for flows. Add a test with every acceptance-relevant change.
- Keep commits as reviewable work units with docs and tests together. Write an ADR for material architecture changes.
- UI copy is Spanish (es-AR); code, comments and docs are English.
