CREATE TYPE "app"."prize_mechanism" AS ENUM('quiniela', 'manual');--> statement-breakpoint
CREATE TABLE "app"."quiniela_draws" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"campaign_id" uuid NOT NULL,
	"round" integer DEFAULT 1 NOT NULL,
	"source" text NOT NULL,
	"drawn_at" timestamp with time zone NOT NULL,
	"extracts" integer[] NOT NULL,
	"evidence_url" text NOT NULL,
	"manifest_sha256" text NOT NULL,
	"recorded_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "quiniela_draws_round_check" CHECK ("app"."quiniela_draws"."round" >= 1),
	CONSTRAINT "quiniela_draws_extracts_check" CHECK (cardinality("app"."quiniela_draws"."extracts") = 20 and 0 <= all("app"."quiniela_draws"."extracts") and 9999 >= all("app"."quiniela_draws"."extracts"))
);
--> statement-breakpoint
ALTER TABLE "app"."prizes" ADD COLUMN "mechanism" "app"."prize_mechanism" DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."quiniela_draws" ADD CONSTRAINT "quiniela_draws_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "app"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."quiniela_draws" ADD CONSTRAINT "quiniela_draws_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "app"."campaigns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "quiniela_draws_round_uq" ON "app"."quiniela_draws" USING btree ("campaign_id","round");--> statement-breakpoint

-- Tenant isolation and append-only evidence for the Quiniela draw record (ADR 0014 §3).
SELECT app.apply_tenant_policy('quiniela_draws');
--> statement-breakpoint
CREATE TRIGGER quiniela_draws_append_only BEFORE UPDATE OR DELETE ON app.quiniela_draws
	FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();
