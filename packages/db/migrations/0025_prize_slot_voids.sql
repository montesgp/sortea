CREATE TABLE "app"."prize_slot_voids" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"campaign_id" uuid NOT NULL,
	"prize_id" uuid NOT NULL,
	"slot" integer NOT NULL,
	"round" integer NOT NULL,
	"reason" text NOT NULL,
	"declared_by" uuid,
	"declared_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "prize_slot_voids_slot_check" CHECK ("app"."prize_slot_voids"."slot" >= 1 and "app"."prize_slot_voids"."round" >= 1),
	CONSTRAINT "prize_slot_voids_reason_check" CHECK (length(trim("app"."prize_slot_voids"."reason")) >= 5)
);
--> statement-breakpoint
ALTER TABLE "app"."prize_slot_voids" ADD CONSTRAINT "prize_slot_voids_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "app"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."prize_slot_voids" ADD CONSTRAINT "prize_slot_voids_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "app"."campaigns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."prize_slot_voids" ADD CONSTRAINT "prize_slot_voids_prize_id_prizes_id_fk" FOREIGN KEY ("prize_id") REFERENCES "app"."prizes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "prize_slot_voids_slot_uq" ON "app"."prize_slot_voids" USING btree ("prize_id","slot");--> statement-breakpoint
CREATE INDEX "prize_slot_voids_campaign_idx" ON "app"."prize_slot_voids" USING btree ("campaign_id");--> statement-breakpoint

-- Prize units declared void ("desierto") when nobody can win them any more (ADR 0024 §7,
-- odd/tasks/owner-feedback-2026-11-11b.md, T13, L18). Additive only: a new table, nothing
-- existing changes. Tenant isolation and append-only evidence like the other award records.
SELECT app.apply_tenant_policy('prize_slot_voids');
--> statement-breakpoint
CREATE TRIGGER prize_slot_voids_append_only BEFORE UPDATE OR DELETE ON app.prize_slot_voids
	FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();
