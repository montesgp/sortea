CREATE TYPE "app"."award_order" AS ENUM('first_to_last', 'last_to_first');--> statement-breakpoint
CREATE TABLE "app"."app_unit_draws" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"campaign_id" uuid NOT NULL,
	"round" integer NOT NULL,
	"sequence" integer NOT NULL,
	"prize_id" uuid NOT NULL,
	"slot" integer NOT NULL,
	"attempt" integer NOT NULL,
	"candidate_sha256" text NOT NULL,
	"candidate_count" integer NOT NULL,
	"candidates" integer[] NOT NULL,
	"entry_number" integer NOT NULL,
	"drawn_at" timestamp with time zone NOT NULL,
	"recorded_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_unit_draws_numbers_check" CHECK ("app"."app_unit_draws"."round" >= 1 and "app"."app_unit_draws"."sequence" >= 1 and "app"."app_unit_draws"."slot" >= 1 and "app"."app_unit_draws"."attempt" >= 1),
	CONSTRAINT "app_unit_draws_candidates_check" CHECK ("app"."app_unit_draws"."candidate_count" >= 1 and "app"."app_unit_draws"."candidate_count" = cardinality("app"."app_unit_draws"."candidates") and "app"."app_unit_draws"."entry_number" = any("app"."app_unit_draws"."candidates"))
);
--> statement-breakpoint
ALTER TABLE "app"."campaigns" ADD COLUMN "award_order" "app"."award_order" DEFAULT 'first_to_last' NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."prize_awards" ADD COLUMN "app_unit_draw_id" uuid;--> statement-breakpoint
ALTER TABLE "app"."app_unit_draws" ADD CONSTRAINT "app_unit_draws_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "app"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."app_unit_draws" ADD CONSTRAINT "app_unit_draws_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "app"."campaigns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."app_unit_draws" ADD CONSTRAINT "app_unit_draws_prize_id_prizes_id_fk" FOREIGN KEY ("prize_id") REFERENCES "app"."prizes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "app_unit_draws_sequence_uq" ON "app"."app_unit_draws" USING btree ("campaign_id","round","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "app_unit_draws_attempt_uq" ON "app"."app_unit_draws" USING btree ("prize_id","slot","attempt");--> statement-breakpoint
ALTER TABLE "app"."prize_awards" ADD CONSTRAINT "prize_awards_app_unit_draw_id_app_unit_draws_id_fk" FOREIGN KEY ("app_unit_draw_id") REFERENCES "app"."app_unit_draws"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

-- Draw room (odd/tasks/draw-room.md T2, T3; ADR 0014 §4, ADR 0024 as amended). Additive only:
-- every campaign keeps today's award order (first_to_last), existing awards keep their rows with
-- app_unit_draw_id null, and stored one-shot app_draws stay as they are. Tenant isolation and
-- append-only evidence for the per-unit tiradas, like app_draws.
SELECT app.apply_tenant_policy('app_unit_draws');
--> statement-breakpoint
CREATE TRIGGER app_unit_draws_append_only BEFORE UPDATE OR DELETE ON app.app_unit_draws
	FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();
