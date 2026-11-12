CREATE TABLE "app"."app_draws" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"campaign_id" uuid NOT NULL,
	"round" integer DEFAULT 1 NOT NULL,
	"candidate_sha256" text NOT NULL,
	"candidate_count" integer NOT NULL,
	"candidates" integer[] NOT NULL,
	"picks" jsonb NOT NULL,
	"drawn_at" timestamp with time zone NOT NULL,
	"recorded_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_draws_round_check" CHECK ("app"."app_draws"."round" >= 1),
	CONSTRAINT "app_draws_candidates_check" CHECK ("app"."app_draws"."candidate_count" >= 1 and "app"."app_draws"."candidate_count" = cardinality("app"."app_draws"."candidates"))
);
--> statement-breakpoint
ALTER TABLE "app"."prize_awards" ADD COLUMN "app_draw_id" uuid;--> statement-breakpoint
ALTER TABLE "app"."app_draws" ADD CONSTRAINT "app_draws_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "app"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."app_draws" ADD CONSTRAINT "app_draws_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "app"."campaigns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "app_draws_round_uq" ON "app"."app_draws" USING btree ("campaign_id","round");--> statement-breakpoint
ALTER TABLE "app"."prize_awards" ADD CONSTRAINT "prize_awards_app_draw_id_app_draws_id_fk" FOREIGN KEY ("app_draw_id") REFERENCES "app"."app_draws"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

-- Vacant prizes drawn in the application (ADR 0024, odd/tasks/owner-feedback-2026-11-11b.md, T9).
-- Additive only: existing awards keep their rows with app_draw_id null (a Quiniela match or a
-- result typed in by hand). Tenant isolation and append-only evidence for the draw record.
SELECT app.apply_tenant_policy('app_draws');
--> statement-breakpoint
CREATE TRIGGER app_draws_append_only BEFORE UPDATE OR DELETE ON app.app_draws
	FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();
