ALTER TABLE "app"."lookup_challenges" ADD COLUMN "group_id" uuid;--> statement-breakpoint
ALTER TABLE "app"."lookup_challenges" ADD COLUMN "email" text;--> statement-breakpoint
ALTER TABLE "app"."lookup_sessions" ADD COLUMN "email" text;