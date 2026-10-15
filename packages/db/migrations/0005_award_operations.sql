ALTER TABLE "app"."prize_awards" ADD COLUMN "decided_by" uuid;--> statement-breakpoint
ALTER TABLE "app"."prize_awards" ADD COLUMN "recorded_by" uuid;--> statement-breakpoint
ALTER TABLE "app"."prize_fulfillments" ADD COLUMN "scheduled_for" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "app"."prize_fulfillments" ADD COLUMN "updated_by" uuid;--> statement-breakpoint
ALTER TABLE "app"."prize_fulfillments" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "prize_awards_entry_uq" ON "app"."prize_awards" USING btree ("campaign_id","entry_id");--> statement-breakpoint
CREATE UNIQUE INDEX "prize_fulfillments_award_uq" ON "app"."prize_fulfillments" USING btree ("award_id");