# Railway-only infrastructure (staging and production)

Move the database, files and back-office sign-in from Supabase to Railway (ADR 0020), then provision `staging` and `production`.
Domain bought by the owner: `tallermotogarage.com.ar` (NIC Argentina, 2026-11-09). Nothing on Railway is created until the owner says so.

## Specs

- **S1** Railway only: "no quiero ir a supabase ... quiero postresql pero en railway tal como lo hacemos con incoders-commerce asi mantengo todo en la misma infra y red local. Mejor seguridad, mejor latencia mas facil de administrar."
- **S2** Two environments, one database each: "Tenemos que manejar 2 ambientes y 2 bases de datos 1 por ambiente digamos. staging y production."
- **S3** Files on Railway: "en railway debemos manejar storage para poder colgar los documentos manuales digitales, y algun video del sorteo y de la moto. Como tambien imagenes del producto a sortear. Simplemente eso no mucho mas."
- **S4** Separate from client projects: "no me gustaria mezclar incoders-commerce con sortea. Porque incoders-commerce es un proyecto dedicado de un cliente no se puede tocar. Manejamos staging y produccion de vaca verde."
- **S5** Plan and backups: "quiza necesitemos el plan de 20 para manejar backups y no tener que estar calculando consumo." Low load: "La plataforma no va a tener alto trafico ni alta demanda ... Es un carrito de compras basicamente."
- **S6** Both Mercado Pago test accounts on staging (carried from docs/launch/environment-setup.md, owner 2026-11-06).

## Tasks

| ID | Specs | Task | Route | Commit |
| --- | --- | --- | --- | --- |
| T1 | S1–S5 | ADR 0020; ARCHITECTURE, PRD and checklist point to it | inline | pending |
| T2 | S1, S2 | Local stack without Supabase: Docker Compose (Postgres 17, MinIO, Mailpit), `db:start`/`db:stop`, one-time dump and restore of the local database, env template, README | worker | |
| T3 | S3 | Files on S3: storage adapter for downloads and media, `/media/<key>` presigned redirect, CSP, seed, `db:product-file`, `db:erase-org`; ADRs 0008, 0009, 0011 | worker | |
| T4 | S1 | Own back-office sign-in: users, scrypt, opaque sessions, TOTP, throttle, audit; commands to create the first admin and reset a user; web session rewrite; remove `@supabase/*`; SECURITY.md, ADR 0005 (high risk: own commit, independent verify, native review) | worker + verify | |
| T5 | S2, S5 | Deploy config: `railway.json` per service, compiled API and worker, pre-deploy migrations, health checks, `staging` branch and CI on it | worker | |
| T6 | S2, S4, S5 | Provision staging: workspace and project `sortea` (owner), `staging` environment (owner, one click), services, Postgres, bucket, variables, backups, `staging.tallermotogarage.com.ar` via Cloudflare, Resend | parent via Railway MCP | |
| T7 | S6 | Staging rehearsal: connect both Mercado Pago test accounts, end-to-end purchase, email, download, backup restore drill | parent + owner | |
| T8 | S2, S5 | Provision production: same as T6 with production credentials, `tallermotogarage.com.ar`, bootstrap admin | parent via Railway MCP | |

## Log

- **L1** (owner, 2026-11-09): "Entonces damos por finalizado toda esa parte y empezamos a enfocarnos en sacar el domino, crear ambiente de staging por mcp de railway y db y variable sy todo lo que necesitemos con ambientes staging y production. Aun no ejecutamos nada pero vamos enfocando en eso, cuando me levante saco dominio y pago el hosting y los 20 usd de railway"
- **L2** (owner): domain for MotoGarage only for now, `.com` acceptable; bought `tallermotogarage.com.ar` at NIC Argentina.
- **L3** (owner): "Pero no quiero ir a supabase. Tenemos eso documentado? Cambiemos esa definicion, quiero postressql pero en railway tal como lo hacemos con incoders-commerce ... Con un plan de 20 USD para sortea se supone estamos sobrados?"
- **L4** (owner): "Si actualicemos el ADR y pensa que tambien en railway debemos manejar storage ..." Reference: a comparable Railway project of the owner's estimates $5.84 a month.
- **L5** (evidence, 2026-11-09): Supabase today provides Postgres, Storage (`apps/api/src/storage.ts`, seed, `product-file`, `erase-organization`) and Auth (`apps/web/src/lib/server/admin-session.ts` against `/auth/v1`, `apps/api/src/lib/admin-auth.ts` JWKS, seed users). Railway Buckets are private only (presigned URLs or proxy), $0.015 per GB-month, free bucket egress. Postgres volume backups: daily 6 days, weekly 27 days, monthly 89 days. The Railway MCP has no tool to create an environment.
