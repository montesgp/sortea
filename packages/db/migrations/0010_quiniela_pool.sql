ALTER TYPE "app"."discrepancy_kind" ADD VALUE 'pool_exhausted';--> statement-breakpoint
ALTER TABLE "app"."campaigns" ALTER COLUMN "next_entry_number" SET DEFAULT 0;--> statement-breakpoint
ALTER TABLE "app"."reconciliation_items" ALTER COLUMN "first_run_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."reconciliation_items" ALTER COLUMN "last_run_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."campaigns" ADD COLUMN "entry_digits" smallint DEFAULT 4 NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."orders" ADD COLUMN "reserved_entries" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX "orders_campaign_status_idx" ON "app"."orders" USING btree ("campaign_id","status","expires_at");--> statement-breakpoint
ALTER TABLE "app"."campaigns" ADD CONSTRAINT "campaigns_entry_digits_check" CHECK ("app"."campaigns"."entry_digits" between 1 and 6);--> statement-breakpoint

-- Coupons live in the pool of the official draw: 0 … 10^entry_digits − 1 (ADR 0014 §1).
CREATE OR REPLACE FUNCTION app.check_entry_in_pool() RETURNS trigger
	LANGUAGE plpgsql
	AS $$
DECLARE
	digits smallint;
BEGIN
	SELECT entry_digits INTO digits FROM app.campaigns WHERE id = NEW.campaign_id;
	IF NEW.entry_number < 0 OR NEW.entry_number >= 10 ^ digits THEN
		RAISE EXCEPTION 'entry number % is outside the coupon pool of its campaign', NEW.entry_number USING ERRCODE = 'check_violation';
	END IF;
	RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER participation_entries_in_pool BEFORE INSERT ON app.participation_entries
	FOR EACH ROW EXECUTE FUNCTION app.check_entry_in_pool();
