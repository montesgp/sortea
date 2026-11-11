-- The account that signed each Mercado Pago notification (odd/tasks/console-polish-2026-11-11.md, S6).
-- No foreign key: payment_events is append-only (0001), so ON DELETE SET NULL could not run when
-- "Desvincular" deletes the accounts; the id stays as a historical reference, like audit targets.
-- Existing notifications keep a null account.
ALTER TABLE "app"."payment_events" ADD COLUMN "integration_id" uuid;--> statement-breakpoint
CREATE INDEX "payment_events_integration_idx" ON "app"."payment_events" USING btree ("integration_id","created_at");
