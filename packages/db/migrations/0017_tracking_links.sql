CREATE TYPE "app"."tracking_channel" AS ENUM('instagram', 'facebook', 'tiktok', 'youtube', 'whatsapp', 'other');--> statement-breakpoint
CREATE TABLE "app"."order_attributions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"tracking_link_id" uuid NOT NULL,
	"touched_at" timestamp with time zone NOT NULL,
	"is_last" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."tracking_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"campaign_id" uuid NOT NULL,
	"name" text NOT NULL,
	"channel" "app"."tracking_channel" NOT NULL,
	"note" text,
	"code" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "app"."orders" ADD COLUMN "source_channel" text;--> statement-breakpoint
ALTER TABLE "app"."order_attributions" ADD CONSTRAINT "order_attributions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "app"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."order_attributions" ADD CONSTRAINT "order_attributions_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "app"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."order_attributions" ADD CONSTRAINT "order_attributions_tracking_link_id_tracking_links_id_fk" FOREIGN KEY ("tracking_link_id") REFERENCES "app"."tracking_links"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."tracking_links" ADD CONSTRAINT "tracking_links_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "app"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."tracking_links" ADD CONSTRAINT "tracking_links_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "app"."campaigns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "order_attributions_uq" ON "app"."order_attributions" USING btree ("order_id","tracking_link_id");--> statement-breakpoint
CREATE UNIQUE INDEX "order_attributions_last_uq" ON "app"."order_attributions" USING btree ("order_id") WHERE "app"."order_attributions"."is_last";--> statement-breakpoint
CREATE INDEX "order_attributions_link_idx" ON "app"."order_attributions" USING btree ("tracking_link_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tracking_links_code_uq" ON "app"."tracking_links" USING btree ("organization_id","code");--> statement-breakpoint
CREATE INDEX "tracking_links_campaign_idx" ON "app"."tracking_links" USING btree ("campaign_id","created_at");--> statement-breakpoint

-- Custom: tenant isolation for tracking links and order attributions (odd/tasks/tracking-links.md).
SELECT app.apply_tenant_policy('tracking_links');
--> statement-breakpoint
SELECT app.apply_tenant_policy('order_attributions');
--> statement-breakpoint
-- A link is archived, never deleted, so its code is never reused inside its organization (S1).
CREATE TRIGGER tracking_links_no_delete BEFORE DELETE ON app.tracking_links
	FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();
