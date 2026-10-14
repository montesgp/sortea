CREATE TABLE "app"."ops_events" (
	"organization_id" uuid NOT NULL,
	"sequence" bigint NOT NULL,
	"kind" text NOT NULL,
	"subject_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ops_events_organization_id_sequence_pk" PRIMARY KEY("organization_id","sequence")
);
--> statement-breakpoint
CREATE TABLE "app"."ops_sequences" (
	"organization_id" uuid PRIMARY KEY NOT NULL,
	"last_sequence" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "app"."ops_events" ADD CONSTRAINT "ops_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "app"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."ops_sequences" ADD CONSTRAINT "ops_sequences_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "app"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ops_events_created_idx" ON "app"."ops_events" USING btree ("created_at");--> statement-breakpoint

-- Tenant isolation for the new tables (ADR 0001).
SELECT app.apply_tenant_policy('ops_sequences');
--> statement-breakpoint
SELECT app.apply_tenant_policy('ops_events');
--> statement-breakpoint

-- Tenants publish and read events but never rewrite them; the platform role prunes old ones.
REVOKE UPDATE, DELETE ON app.ops_events FROM sortea_app;
--> statement-breakpoint

-- NOTIFY is delivered on commit, in commit order, so listeners only hear about committed changes (ADR 0007).
CREATE OR REPLACE FUNCTION app.notify_ops_event() RETURNS trigger
	LANGUAGE plpgsql
	AS $$
BEGIN
	PERFORM pg_notify(
		'sortea_ops_events',
		json_build_object('organizationId', NEW.organization_id, 'sequence', NEW.sequence, 'kind', NEW.kind, 'subjectId', NEW.subject_id)::text
	);
	RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER ops_events_notify AFTER INSERT ON app.ops_events
	FOR EACH ROW EXECUTE FUNCTION app.notify_ops_event();
