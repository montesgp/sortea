CREATE TABLE "app"."admin_trusted_devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"user_agent" text
);
--> statement-breakpoint
ALTER TABLE "app"."admin_trusted_devices" ADD CONSTRAINT "admin_trusted_devices_user_id_admin_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "app"."admin_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "admin_trusted_devices_token_uq" ON "app"."admin_trusted_devices" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "admin_trusted_devices_user_idx" ON "app"."admin_trusted_devices" USING btree ("user_id");--> statement-breakpoint

-- Custom: remembered browsers of the second factor (odd/tasks/launch-prep-2026-11-10.md, S1;
-- docs/spec/SECURITY.md "Acceso al panel"). A platform table like admin_sessions (migration 0018):
-- no organization_id, and it holds token hashes, so no API role may read it, not even through
-- RLS. The default privileges of migration 0001 granted it to sortea_app; that is revoked here,
-- and row level security is enabled with no policy as a second lock. The API reaches it only
-- through its named sign-in paths with the owner connection (db.withPlatform).
REVOKE ALL ON app.admin_trusted_devices FROM sortea_app;
--> statement-breakpoint
ALTER TABLE app.admin_trusted_devices ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DO $$
DECLARE r text;
BEGIN
	FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
		IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
			EXECUTE format('REVOKE ALL ON app.admin_trusted_devices FROM %I', r);
		END IF;
	END LOOP;
END $$;
