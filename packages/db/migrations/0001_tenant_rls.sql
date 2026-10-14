-- Tenant isolation at the database level (FR-ORG-04, AC-02) and append-only
-- guarantees for evidence tables (FR-ENTRY-02, FR-OPS-05, DRAW-INTEGRITY).
--
-- The API connects as the schema owner but runs every tenant request inside a
-- transaction that does `SET LOCAL ROLE sortea_app` after pinning
-- `app.organization_id`. sortea_app is not the owner and has no BYPASSRLS, so
-- the policies below always apply to it.

-- The grant names the user explicitly: `GRANT ... TO CURRENT_USER` crashes
-- Supabase's Postgres 17 build (segfault in a role-grant hook).
DO $$
BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sortea_app') THEN
		CREATE ROLE sortea_app NOLOGIN NOINHERIT;
	END IF;
	EXECUTE format('GRANT sortea_app TO %I', current_user);
END $$;
--> statement-breakpoint
GRANT USAGE ON SCHEMA app TO sortea_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA app TO sortea_app;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA app GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO sortea_app;
--> statement-breakpoint
REVOKE ALL ON app.platform_admins FROM sortea_app;
--> statement-breakpoint
REVOKE ALL ON app.__migrations FROM sortea_app;
--> statement-breakpoint

-- Supabase's API roles must never reach this schema, not even with RLS.
DO $$
DECLARE r text;
BEGIN
	FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
		IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
			EXECUTE format('REVOKE ALL ON SCHEMA app FROM %I', r);
			EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA app FROM %I', r);
		END IF;
	END LOOP;
END $$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.current_organization_id() RETURNS uuid
	LANGUAGE sql STABLE
	AS $$ SELECT nullif(current_setting('app.organization_id', true), '')::uuid $$;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.current_organization_id() TO sortea_app;
--> statement-breakpoint

ALTER TABLE app.organizations ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_self ON app.organizations TO sortea_app
	USING (id = app.current_organization_id());
--> statement-breakpoint
ALTER TABLE app.platform_admins ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

-- Every table that carries organization_id gets the same isolation policy.
-- New tables must call app.apply_tenant_policy() in their migration; the db
-- test suite fails if any tenant table is left without RLS.
CREATE OR REPLACE FUNCTION app.apply_tenant_policy(table_name text) RETURNS void
	LANGUAGE plpgsql
	AS $$
BEGIN
	EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY', table_name);
	EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON app.%I', table_name);
	EXECUTE format(
		'CREATE POLICY tenant_isolation ON app.%I TO sortea_app
			USING (organization_id = app.current_organization_id())
			WITH CHECK (organization_id = app.current_organization_id())',
		table_name
	);
END $$;
--> statement-breakpoint
DO $$
DECLARE t record;
BEGIN
	FOR t IN
		SELECT c.relname
		FROM pg_class c
		JOIN pg_namespace n ON n.oid = c.relnamespace
		JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'organization_id' AND NOT a.attisdropped
		WHERE n.nspname = 'app' AND c.relkind = 'r'
	LOOP
		PERFORM app.apply_tenant_policy(t.relname);
	END LOOP;
END $$;
--> statement-breakpoint

-- Append-only evidence.
CREATE OR REPLACE FUNCTION app.forbid_mutation() RETURNS trigger
	LANGUAGE plpgsql
	AS $$
BEGIN
	RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
END $$;
--> statement-breakpoint
CREATE TRIGGER entry_ledger_events_append_only BEFORE UPDATE OR DELETE ON app.entry_ledger_events
	FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER audit_events_append_only BEFORE UPDATE OR DELETE ON app.audit_events
	FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER draw_events_append_only BEFORE UPDATE OR DELETE ON app.draw_events
	FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER contact_consents_append_only BEFORE UPDATE OR DELETE ON app.contact_consents
	FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER payment_events_append_only BEFORE UPDATE OR DELETE ON app.payment_events
	FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();
--> statement-breakpoint

-- Entries are never deleted; only their status may move from eligible to void.
CREATE OR REPLACE FUNCTION app.protect_entries() RETURNS trigger
	LANGUAGE plpgsql
	AS $$
BEGIN
	IF TG_OP = 'DELETE' THEN
		RAISE EXCEPTION 'participation entries cannot be deleted' USING ERRCODE = 'insufficient_privilege';
	END IF;
	IF NEW.entry_number <> OLD.entry_number OR NEW.contact_id <> OLD.contact_id OR NEW.campaign_id <> OLD.campaign_id
		OR NEW.order_id <> OLD.order_id OR NEW.holder_pseudonym <> OLD.holder_pseudonym
		OR (OLD.status = 'void' AND NEW.status <> 'void') THEN
		RAISE EXCEPTION 'participation entries are immutable except eligible -> void' USING ERRCODE = 'insufficient_privilege';
	END IF;
	RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER participation_entries_protect BEFORE UPDATE OR DELETE ON app.participation_entries
	FOR EACH ROW EXECUTE FUNCTION app.protect_entries();
--> statement-breakpoint

-- A locked rule version can only be superseded, never edited or deleted (AC-08).
CREATE OR REPLACE FUNCTION app.protect_locked_rules() RETURNS trigger
	LANGUAGE plpgsql
	AS $$
BEGIN
	IF OLD.status = 'draft' THEN
		IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
		RETURN NEW;
	END IF;
	IF TG_OP = 'DELETE' THEN
		RAISE EXCEPTION 'locked rule versions cannot be deleted' USING ERRCODE = 'insufficient_privilege';
	END IF;
	IF NEW.body_markdown IS DISTINCT FROM OLD.body_markdown
		OR NEW.eligibility IS DISTINCT FROM OLD.eligibility
		OR NEW.entry_rule IS DISTINCT FROM OLD.entry_rule
		OR NEW.content_hash IS DISTINCT FROM OLD.content_hash
		OR NEW.version <> OLD.version
		OR NOT (NEW.status = OLD.status OR (OLD.status = 'locked' AND NEW.status = 'superseded')) THEN
		RAISE EXCEPTION 'locked rule versions are immutable' USING ERRCODE = 'insufficient_privilege';
	END IF;
	RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER campaign_rule_versions_protect BEFORE UPDATE OR DELETE ON app.campaign_rule_versions
	FOR EACH ROW EXECUTE FUNCTION app.protect_locked_rules();
--> statement-breakpoint

-- A published manifest is a public commitment and cannot change.
CREATE OR REPLACE FUNCTION app.protect_manifest() RETURNS trigger
	LANGUAGE plpgsql
	AS $$
BEGIN
	IF TG_OP = 'DELETE' OR NEW.sha256 <> OLD.sha256 OR NEW.content <> OLD.content
		OR (OLD.published_at IS NOT NULL AND NEW.published_at IS DISTINCT FROM OLD.published_at) THEN
		RAISE EXCEPTION 'draw manifests are immutable' USING ERRCODE = 'insufficient_privilege';
	END IF;
	RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER draw_manifests_protect BEFORE UPDATE OR DELETE ON app.draw_manifests
	FOR EACH ROW EXECUTE FUNCTION app.protect_manifest();
