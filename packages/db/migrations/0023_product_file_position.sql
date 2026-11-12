-- A digital product may hold several files, each with its own download link, listed in this
-- order (odd/tasks/owner-feedback-2026-11-11b.md, S2, T5). Existing files keep their rows and ids,
-- which download grants point to, and take position 0, the first of their product. The table
-- already has its tenant policy (0001), so no RLS change is needed.
ALTER TABLE "app"."product_assets" ADD COLUMN "position" integer DEFAULT 0 NOT NULL;
