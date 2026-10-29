ALTER TYPE "app"."discrepancy_kind" ADD VALUE 'account_unavailable';--> statement-breakpoint
DROP INDEX "app"."organization_integrations_uq";--> statement-breakpoint
ALTER TABLE "app"."orders" ADD COLUMN "payment_integration_id" uuid;--> statement-breakpoint
ALTER TABLE "app"."organization_integrations" ADD COLUMN "retired_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "app"."orders" ADD CONSTRAINT "orders_payment_integration_id_organization_integrations_id_fk" FOREIGN KEY ("payment_integration_id") REFERENCES "app"."organization_integrations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- Custom: one active Mercado Pago account per organization. An organization left with
-- several active rows keeps the most recently updated one; every inactive row is a
-- previous (retired) account whose sealed credentials are kept.
UPDATE "app"."organization_integrations" AS i SET "is_active" = false
WHERE i."is_active" AND EXISTS (
	SELECT 1 FROM "app"."organization_integrations" AS o
	WHERE o."organization_id" = i."organization_id" AND o."provider" = i."provider" AND o."is_active"
		AND (o."updated_at", o."id") > (i."updated_at", i."id")
);--> statement-breakpoint
UPDATE "app"."organization_integrations" SET "retired_at" = "updated_at" WHERE NOT "is_active" AND "retired_at" IS NULL;--> statement-breakpoint
-- Custom: existing orders of an organization with exactly one Mercado Pago account were
-- created with it. Any other order stays unassigned (legacy): its payments are matched
-- by the account whose signature validates and by that account's collector.
UPDATE "app"."orders" AS o SET "payment_integration_id" = single."id"
FROM (
	SELECT "organization_id", (array_agg("id"))[1] AS "id"
	FROM "app"."organization_integrations"
	WHERE "provider" = 'mercadopago'
	GROUP BY "organization_id"
	HAVING count(*) = 1
) AS single
WHERE o."organization_id" = single."organization_id" AND o."payment_provider" = 'mercadopago' AND o."payment_integration_id" IS NULL;--> statement-breakpoint
CREATE INDEX "orders_payment_integration_idx" ON "app"."orders" USING btree ("payment_integration_id","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "organization_integrations_active_uq" ON "app"."organization_integrations" USING btree ("organization_id","provider") WHERE "app"."organization_integrations"."is_active";--> statement-breakpoint
CREATE INDEX "organization_integrations_org_idx" ON "app"."organization_integrations" USING btree ("organization_id","provider");