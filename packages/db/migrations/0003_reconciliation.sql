CREATE TYPE "app"."discrepancy_kind" AS ENUM('payment_missing_in_system', 'payment_missing_at_provider', 'unknown_reference', 'amount_mismatch', 'status_mismatch', 'refund_not_applied', 'partial_refund', 'settlement_amount_mismatch', 'settlement_missing', 'settlement_unmatched');--> statement-breakpoint
CREATE TYPE "app"."discrepancy_severity" AS ENUM('critical', 'warning');--> statement-breakpoint
CREATE TYPE "app"."reconciliation_item_status" AS ENUM('open', 'resolved');--> statement-breakpoint
CREATE TYPE "app"."reconciliation_resolution" AS ENUM('provider_state_applied', 'cleared', 'accepted');--> statement-breakpoint
CREATE TYPE "app"."reconciliation_run_kind" AS ENUM('operations', 'settlements');--> statement-breakpoint
CREATE TYPE "app"."reconciliation_run_status" AS ENUM('running', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "app"."reconciliation_run_trigger" AS ENUM('scheduled', 'manual', 'upload');--> statement-breakpoint
CREATE TABLE "app"."payment_settlements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"run_id" uuid NOT NULL,
	"row_key" text NOT NULL,
	"provider_payment_id" text NOT NULL,
	"external_reference" text,
	"transaction_type" text NOT NULL,
	"gross_minor" bigint NOT NULL,
	"fee_minor" bigint NOT NULL,
	"net_minor" bigint NOT NULL,
	"currency" text NOT NULL,
	"transaction_at" timestamp with time zone,
	"settled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."reconciliation_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"first_run_id" uuid NOT NULL,
	"last_run_id" uuid NOT NULL,
	"kind" "app"."discrepancy_kind" NOT NULL,
	"severity" "app"."discrepancy_severity" NOT NULL,
	"fingerprint" text NOT NULL,
	"provider_payment_id" text,
	"order_reference" text,
	"order_id" uuid,
	"expected" jsonb NOT NULL,
	"observed" jsonb NOT NULL,
	"status" "app"."reconciliation_item_status" DEFAULT 'open' NOT NULL,
	"resolution" "app"."reconciliation_resolution",
	"resolution_note" text,
	"resolved_by" uuid,
	"resolved_at" timestamp with time zone,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."reconciliation_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"kind" "app"."reconciliation_run_kind" NOT NULL,
	"trigger" "app"."reconciliation_run_trigger" NOT NULL,
	"status" "app"."reconciliation_run_status" DEFAULT 'running' NOT NULL,
	"window_from" timestamp with time zone NOT NULL,
	"window_to" timestamp with time zone NOT NULL,
	"started_by" uuid,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"summary" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error" text
);
--> statement-breakpoint
ALTER TABLE "app"."payments" ADD COLUMN "fee_minor" bigint;--> statement-breakpoint
ALTER TABLE "app"."payments" ADD COLUMN "net_minor" bigint;--> statement-breakpoint
ALTER TABLE "app"."payments" ADD COLUMN "refunded_minor" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."payments" ADD COLUMN "release_date" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "app"."payments" ADD COLUMN "release_status" text;--> statement-breakpoint
ALTER TABLE "app"."payments" ADD COLUMN "provider_updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "app"."payment_settlements" ADD CONSTRAINT "payment_settlements_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "app"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."payment_settlements" ADD CONSTRAINT "payment_settlements_run_id_reconciliation_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "app"."reconciliation_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."reconciliation_items" ADD CONSTRAINT "reconciliation_items_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "app"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."reconciliation_items" ADD CONSTRAINT "reconciliation_items_first_run_id_reconciliation_runs_id_fk" FOREIGN KEY ("first_run_id") REFERENCES "app"."reconciliation_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."reconciliation_items" ADD CONSTRAINT "reconciliation_items_last_run_id_reconciliation_runs_id_fk" FOREIGN KEY ("last_run_id") REFERENCES "app"."reconciliation_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."reconciliation_items" ADD CONSTRAINT "reconciliation_items_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "app"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."reconciliation_runs" ADD CONSTRAINT "reconciliation_runs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "app"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "payment_settlements_row_uq" ON "app"."payment_settlements" USING btree ("organization_id","provider","row_key");--> statement-breakpoint
CREATE INDEX "payment_settlements_payment_idx" ON "app"."payment_settlements" USING btree ("organization_id","provider_payment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "reconciliation_items_open_uq" ON "app"."reconciliation_items" USING btree ("organization_id","fingerprint") WHERE "app"."reconciliation_items"."status" = 'open';--> statement-breakpoint
CREATE INDEX "reconciliation_items_status_idx" ON "app"."reconciliation_items" USING btree ("organization_id","status","last_seen_at");--> statement-breakpoint
CREATE INDEX "reconciliation_runs_org_idx" ON "app"."reconciliation_runs" USING btree ("organization_id","kind","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "reconciliation_runs_running_uq" ON "app"."reconciliation_runs" USING btree ("organization_id","kind") WHERE "app"."reconciliation_runs"."status" = 'running';--> statement-breakpoint
CREATE INDEX "payments_updated_idx" ON "app"."payments" USING btree ("organization_id","updated_at");--> statement-breakpoint

-- Tenant isolation for the new tables (ADR 0001).
SELECT app.apply_tenant_policy('reconciliation_runs');
--> statement-breakpoint
SELECT app.apply_tenant_policy('reconciliation_items');
--> statement-breakpoint
SELECT app.apply_tenant_policy('payment_settlements');
--> statement-breakpoint

-- A settlement report is evidence: its movements are never edited or removed.
CREATE TRIGGER payment_settlements_append_only BEFORE UPDATE OR DELETE ON app.payment_settlements
	FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();
