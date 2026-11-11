CREATE TYPE "app"."admin_assurance" AS ENUM('password', 'mfa');--> statement-breakpoint
CREATE TYPE "app"."admin_user_status" AS ENUM('active', 'disabled');--> statement-breakpoint
CREATE TABLE "app"."admin_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_hash" text NOT NULL,
	"user_id" uuid NOT NULL,
	"assurance" "app"."admin_assurance" DEFAULT 'password' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"idle_expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"address" text,
	"user_agent" text
);
--> statement-breakpoint
CREATE TABLE "app"."admin_sign_in_throttle" (
	"key" text PRIMARY KEY NOT NULL,
	"failures" integer DEFAULT 0 NOT NULL,
	"window_started_at" timestamp with time zone NOT NULL,
	"locked_until" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "app"."admin_users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"status" "app"."admin_user_status" DEFAULT 'active' NOT NULL,
	"must_change_password" boolean DEFAULT false NOT NULL,
	"totp_secret_sealed" text,
	"totp_confirmed_at" timestamp with time zone,
	"totp_last_step" bigint,
	"password_changed_at" timestamp with time zone,
	"last_sign_in_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "app"."admin_sessions" ADD CONSTRAINT "admin_sessions_user_id_admin_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "app"."admin_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "admin_sessions_token_uq" ON "app"."admin_sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "admin_sessions_user_idx" ON "app"."admin_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "admin_users_email_uq" ON "app"."admin_users" USING btree (lower("email"));--> statement-breakpoint

-- Custom: back-office sign-in owned by the API (ADR 0020, docs/spec/SECURITY.md "Acceso al panel").
-- These are platform tables with no organization_id: a person may belong to several
-- organizations, so no tenant policy can describe them. They hold password hashes, sealed
-- TOTP secrets and session token hashes, so no API role may read them, not even through RLS:
-- the default privileges of migration 0001 granted them to sortea_app, and that is revoked
-- here. Row level security is enabled with no policy as a second lock. The API reaches them
-- only through its named sign-in paths with the owner connection (db.withPlatform).
REVOKE ALL ON app.admin_users, app.admin_sessions, app.admin_sign_in_throttle FROM sortea_app;
--> statement-breakpoint
ALTER TABLE app.admin_users ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE app.admin_sessions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE app.admin_sign_in_throttle ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DO $$
DECLARE r text;
BEGIN
	FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
		IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
			EXECUTE format('REVOKE ALL ON app.admin_users, app.admin_sessions, app.admin_sign_in_throttle FROM %I', r);
		END IF;
	END LOOP;
END $$;
