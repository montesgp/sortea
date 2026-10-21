DROP INDEX "app"."draw_manifests_campaign_uq";--> statement-breakpoint
ALTER TABLE "app"."campaigns" ADD COLUMN "current_round" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."draw_events" ADD COLUMN "round" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."draw_manifests" ADD COLUMN "round" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."prize_awards" ADD COLUMN "round" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "draw_manifests_round_uq" ON "app"."draw_manifests" USING btree ("campaign_id","round");--> statement-breakpoint
ALTER TABLE "app"."campaigns" ADD CONSTRAINT "campaigns_current_round_check" CHECK ("app"."campaigns"."current_round" >= 1);--> statement-breakpoint
ALTER TABLE "app"."draw_manifests" ADD CONSTRAINT "draw_manifests_round_check" CHECK ("app"."draw_manifests"."round" >= 1);