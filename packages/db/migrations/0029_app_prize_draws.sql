CREATE TABLE "app"."app_prize_draw_reveals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"campaign_id" uuid NOT NULL,
	"draw_id" uuid NOT NULL,
	"drand_round" integer NOT NULL,
	"signature" text NOT NULL,
	"randomness" text NOT NULL,
	"picks" jsonb NOT NULL,
	"revealed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_prize_draw_reveals_beacon_check" CHECK ("app"."app_prize_draw_reveals"."randomness" ~ '^[0-9a-f]{64}$' and "app"."app_prize_draw_reveals"."signature" ~ '^[0-9a-f]+$' and jsonb_typeof("app"."app_prize_draw_reveals"."picks") = 'array')
);
--> statement-breakpoint
CREATE TABLE "app"."app_prize_draws" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"campaign_id" uuid NOT NULL,
	"round" integer NOT NULL,
	"sequence" integer NOT NULL,
	"prize_id" uuid NOT NULL,
	"attempt" integer NOT NULL,
	"slots" integer[] NOT NULL,
	"drand_chain" text NOT NULL,
	"drand_round" integer NOT NULL,
	"candidate_sha256" text NOT NULL,
	"candidate_count" integer NOT NULL,
	"candidates" integer[] NOT NULL,
	"committed_at" timestamp with time zone NOT NULL,
	"committed_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_prize_draws_drand_round_uq" UNIQUE("id","drand_round"),
	CONSTRAINT "app_prize_draws_numbers_check" CHECK ("app"."app_prize_draws"."round" >= 1 and "app"."app_prize_draws"."sequence" >= 1 and "app"."app_prize_draws"."attempt" >= 1 and "app"."app_prize_draws"."drand_round" >= 1 and cardinality("app"."app_prize_draws"."slots") >= 1 and 1 <= all("app"."app_prize_draws"."slots")),
	CONSTRAINT "app_prize_draws_candidates_check" CHECK ("app"."app_prize_draws"."candidate_count" >= 1 and "app"."app_prize_draws"."candidate_count" = cardinality("app"."app_prize_draws"."candidates") and "app"."app_prize_draws"."candidate_sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "app"."prize_awards" ADD COLUMN "app_prize_draw_id" uuid;--> statement-breakpoint
ALTER TABLE "app"."app_prize_draw_reveals" ADD CONSTRAINT "app_prize_draw_reveals_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "app"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."app_prize_draw_reveals" ADD CONSTRAINT "app_prize_draw_reveals_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "app"."campaigns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."app_prize_draw_reveals" ADD CONSTRAINT "app_prize_draw_reveals_draw_fk" FOREIGN KEY ("draw_id","drand_round") REFERENCES "app"."app_prize_draws"("id","drand_round") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."app_prize_draws" ADD CONSTRAINT "app_prize_draws_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "app"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."app_prize_draws" ADD CONSTRAINT "app_prize_draws_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "app"."campaigns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."app_prize_draws" ADD CONSTRAINT "app_prize_draws_prize_id_prizes_id_fk" FOREIGN KEY ("prize_id") REFERENCES "app"."prizes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "app_prize_draw_reveals_draw_uq" ON "app"."app_prize_draw_reveals" USING btree ("draw_id");--> statement-breakpoint
CREATE UNIQUE INDEX "app_prize_draws_sequence_uq" ON "app"."app_prize_draws" USING btree ("campaign_id","round","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "app_prize_draws_attempt_uq" ON "app"."app_prize_draws" USING btree ("prize_id","attempt");--> statement-breakpoint
ALTER TABLE "app"."prize_awards" ADD CONSTRAINT "prize_awards_app_prize_draw_id_app_prize_draws_id_fk" FOREIGN KEY ("app_prize_draw_id") REFERENCES "app"."app_prize_draws"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

-- Drand-backed tiradas of `app` prizes (odd/tasks/draw-room.md T8, ADR 0026). Additive only: every
-- existing award keeps app_prize_draw_id null, and nothing here uses the `app` mechanism value that
-- 0028 adds, so both run in one migration transaction. Tenant isolation and append-only evidence,
-- like app_unit_draws: a commitment and its reveal are never updated or deleted.
SELECT app.apply_tenant_policy('app_prize_draws');
--> statement-breakpoint
SELECT app.apply_tenant_policy('app_prize_draw_reveals');
--> statement-breakpoint
CREATE TRIGGER app_prize_draws_append_only BEFORE UPDATE OR DELETE ON app.app_prize_draws
	FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER app_prize_draw_reveals_append_only BEFORE UPDATE OR DELETE ON app.app_prize_draw_reveals
	FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();
