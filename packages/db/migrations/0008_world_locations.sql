CREATE TABLE "app"."geo_cities" (
	"geoname_id" integer PRIMARY KEY NOT NULL,
	"country_code" text NOT NULL,
	"subdivision_code" text,
	"name" text NOT NULL,
	"ascii_name" text NOT NULL,
	"search_name" text NOT NULL,
	"population" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."geo_countries" (
	"code" text PRIMARY KEY NOT NULL,
	"iso3" text NOT NULL,
	"name" text NOT NULL,
	"continent" text NOT NULL,
	"geoname_id" integer,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."geo_subdivisions" (
	"country_code" text NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"ascii_name" text NOT NULL,
	"geoname_id" integer,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "geo_subdivisions_country_code_code_pk" PRIMARY KEY("country_code","code")
);
--> statement-breakpoint
ALTER TABLE "app"."geo_cities" ADD CONSTRAINT "geo_cities_country_code_geo_countries_code_fk" FOREIGN KEY ("country_code") REFERENCES "app"."geo_countries"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."geo_subdivisions" ADD CONSTRAINT "geo_subdivisions_country_code_geo_countries_code_fk" FOREIGN KEY ("country_code") REFERENCES "app"."geo_countries"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "geo_cities_search_idx" ON "app"."geo_cities" USING btree ("country_code","search_name" text_pattern_ops);--> statement-breakpoint
CREATE INDEX "geo_cities_subdivision_search_idx" ON "app"."geo_cities" USING btree ("country_code","subdivision_code","search_name" text_pattern_ops);--> statement-breakpoint

-- World locations are platform reference data (ADR 0012): no organization_id and
-- no RLS. The default privileges of 0001 gave sortea_app write access; it may only
-- read them. `pnpm db:geo` writes them with the owner connection.
REVOKE ALL ON app.geo_countries, app.geo_subdivisions, app.geo_cities FROM sortea_app;
--> statement-breakpoint
GRANT SELECT ON app.geo_countries, app.geo_subdivisions, app.geo_cities TO sortea_app;
--> statement-breakpoint
DO $$
DECLARE r text;
BEGIN
	FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
		IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
			EXECUTE format('REVOKE ALL ON app.geo_countries, app.geo_subdivisions, app.geo_cities FROM %I', r);
		END IF;
	END LOOP;
END $$;
