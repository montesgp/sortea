CREATE TABLE "app"."cms_block_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"block_id" uuid NOT NULL,
	"key" text NOT NULL,
	"locale" text NOT NULL,
	"version" integer NOT NULL,
	"content" jsonb NOT NULL,
	"published_by" uuid,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."cms_media" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"storage_path" text NOT NULL,
	"sha256" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"filename" text NOT NULL,
	"uploaded_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cms_media_storage_path_unique" UNIQUE("storage_path")
);
--> statement-breakpoint
ALTER TABLE "app"."cms_blocks" ALTER COLUMN "content" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."cms_blocks" ADD COLUMN "published_by" uuid;--> statement-breakpoint
ALTER TABLE "app"."cms_blocks" ADD COLUMN "draft" jsonb;--> statement-breakpoint
ALTER TABLE "app"."cms_blocks" ADD COLUMN "draft_updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "app"."cms_block_revisions" ADD CONSTRAINT "cms_block_revisions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "app"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."cms_block_revisions" ADD CONSTRAINT "cms_block_revisions_block_id_cms_blocks_id_fk" FOREIGN KEY ("block_id") REFERENCES "app"."cms_blocks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."cms_media" ADD CONSTRAINT "cms_media_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "app"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "cms_block_revisions_uq" ON "app"."cms_block_revisions" USING btree ("block_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "cms_media_sha_uq" ON "app"."cms_media" USING btree ("organization_id","sha256");--> statement-breakpoint

-- Tenant isolation for the new tables (ADR 0001).
SELECT app.apply_tenant_policy('cms_block_revisions');
--> statement-breakpoint
SELECT app.apply_tenant_policy('cms_media');
--> statement-breakpoint

-- Published content is evidence of what the site showed; it is never rewritten.
CREATE TRIGGER cms_block_revisions_append_only BEFORE UPDATE OR DELETE ON app.cms_block_revisions
	FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();
