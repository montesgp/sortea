CREATE TYPE "app"."expense_category" AS ENUM('tecnologia', 'dominio', 'repuestos', 'mano_de_obra', 'combustible', 'publicidad', 'comisiones', 'otros');--> statement-breakpoint
CREATE TABLE "app"."campaign_expenses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"campaign_id" uuid NOT NULL,
	"category" "app"."expense_category" NOT NULL,
	"detail" text NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency" text NOT NULL,
	"spent_on" date NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "campaign_expenses_amount_check" CHECK ("app"."campaign_expenses"."amount_minor" > 0),
	CONSTRAINT "campaign_expenses_detail_check" CHECK (length("app"."campaign_expenses"."detail") between 1 and 200)
);
--> statement-breakpoint
ALTER TABLE "app"."campaign_expenses" ADD CONSTRAINT "campaign_expenses_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "app"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."campaign_expenses" ADD CONSTRAINT "campaign_expenses_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "app"."campaigns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "campaign_expenses_campaign_idx" ON "app"."campaign_expenses" USING btree ("organization_id","campaign_id");--> statement-breakpoint

-- Custom: tenant isolation for campaign expenses (odd/tasks/campaign-finance.md T1, ADR 0025).
-- The app role's table grants come from the default privileges of 0001. Expenses are edited and
-- deleted, not append-only: the audit log keeps every change.
SELECT app.apply_tenant_policy('campaign_expenses');
