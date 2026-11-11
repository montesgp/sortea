# Sortea

Multi-tenant platform for campaign commerce, prize operations and public transparency. Each organization gets its own domain, theme, brand site, Mercado Pago account and isolated data.

> Paid participations stay disabled until a campaign has legal and payment-provider approvals on record. The platform never invents them: a campaign cannot open without them (see [Draw integrity](docs/spec/DRAW-INTEGRITY.md)).

## What is in the box

| Area | Status |
| --- | --- |
| Tenancy: hostname → organization, row level security per organization, roles | Done |
| Themes per organization (design tokens, dark/light, WCAG AA fallback) | Done |
| Brand sites switched by CMS content (the first one: roller-shutter hero, scroll-driven piston cycle) | Done |
| Campaign microsite: prizes, countdown on server time, rules, compliance state | Done |
| Transparency: versioned rules, public log, frozen manifest with SHA-256 | Done |
| Shop, cart with explicit extras, guest checkout with separate consents | Done |
| Mercado Pago Checkout Pro (Orders API), signed order webhooks, idempotent confirmation | Done (sandbox and local simulator) |
| Participation ledger (append-only), refunds void entries without deleting them | Done |
| Private lookup by document + emailed code, or receipt code | Done |
| Signed, expiring downloads for digital products | Done |
| Durable outbox and email (Mailpit locally, Resend in production) | Done |
| Admin: live dashboard (snapshot plus server-sent events, resync after disconnects), orders with masked data, campaigns, audit | Done |
| Platform console: organizations, write-only credentials, theme, domains | Done |
| Payment reconciliation: scheduled checks, settlement reports, human resolution, CSV exports | Done |
| Awards: results checked against the manifest, alternates, verification and per-unit delivery (AC-06) | Done |
| Quiniela draw (ADR 0014): coupons 0000-9999, prizes matched against the 20 official extracts; a vacant prize reopens the campaign for a new round with its own closing date, manifest and draw | Done |
| Catalog and prize editing: drafts, variants with es-AR prices, archive instead of delete; prizes frozen once open | Done |
| Site editor (CMS): brand, home, SEO/OpenGraph, banner, restorations gallery with photo credits, legal texts with versions, FAQs, image library; drafts, publishing and history | Done |

## Architecture

```mermaid
flowchart LR
  B[Browser] --> W[apps/web<br/>SvelteKit SSR + BFF]
  W -->|internal token + real host| A[apps/api<br/>Fastify]
  MP[Mercado Pago] -->|signed webhook| A
  A --> DB[(Postgres<br/>schema app + RLS)]
  A -->|re-read payment| MP
  A -->|outbox| DB
  DB -->|NOTIFY on commit| A
  A -->|server-sent events| W
  K[apps/worker] -->|claims outbox| DB
  K -->|schedules reconciliation| A
  K --> E[Email: Mailpit / Resend]
```

- `packages/domain`: pure business rules (pricing, campaign lifecycle and compliance gate, payment state, documents, manifest, themes) plus server crypto (sealed secrets, webhook signatures, tokens).
- `packages/db`: Drizzle schema, migrations, seed, client packs and the `withTenant` / `withPlatform` database handle.
- `apps/api`: the only place with business rules and secrets. Private except `/webhooks/*`.
- `apps/web`: SSR pages and a thin BFF. Browsers never call the API.
- `apps/worker`: outbox processing, email, order expiry, and the clock for payment reconciliation (the API does the work).

Key decisions are recorded in [docs/adr](docs/adr). The product brief lives in [docs/spec](docs/spec).

## Run it locally

Requirements: Node 22.17+, pnpm 11 and Docker Desktop (with Docker Compose v2). Nothing else: PostgreSQL 18, Mailpit and MinIO run from `docker-compose.yml`, and no PostgreSQL client is needed on the machine.

On Windows, `scripts/dev/run-all.bat` does everything below in one step: it checks the tooling, starts Docker Desktop and the local stack, writes `.env` when missing, refreshes dependencies, migrates, seeds and starts the stack in its own window. `run-all.bat test` prepares the same way and runs the typecheck, the test suites and the E2E tests; `run-all.bat doctor` only reports what is missing (`pnpm doctor` does the same on any OS). Set `SEED_ADMIN_PASSWORD` in `.env` so the local accounts have a known password and the E2E tests can sign in.

```bash
pnpm install
pnpm db:start        # docker-compose.yml: Postgres :54322, Mailpit :54324 (SMTP :54325), MinIO :9000
pnpm setup:env       # writes .env from env.template with fresh secrets
pnpm storage:init    # creates the bucket named by S3_BUCKET (once)
pnpm db:migrate
pnpm db:seed         # prints the password of the local admin accounts
pnpm db:geo          # countries, provinces and cities from GeoNames (downloads once)
pnpm dev             # api :3001, worker, web :5173
```

| URL | What |
| --- | --- |
| http://localhost:5173 | Taller Demo, the fictional first organization (http://demo.localhost:5173 when a client pack already has `localhost`) |
| http://pista.localhost:5173 | Pista Sur, a fictional second tenant |
| http://localhost:5173/admin | Admin panel |
| http://127.0.0.1:54324 | Mailpit: every email sent locally |
| http://127.0.0.1:9001 | MinIO console: the files bucket (user and password are `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY`) |

Seeded accounts (password printed by the seed): `admin@sortea.local` (platform), `owner@tallerdemo.local`, `operador@tallerdemo.local`, `finanzas@tallerdemo.local`, `owner@pistasur.local`.

`pnpm db:stop` stops the stack; its data stays in the named volumes `sortea_postgres-data` and `sortea_minio-data`. Every port listens on 127.0.0.1 only. `pnpm db:start` and `pnpm db:stop` name the services of `docker-compose.yml` explicitly, because the Supabase CLI labels its own containers with the same compose project (`sortea`); never run `docker compose down --remove-orphans` while Supabase CLI containers exist.

### Moving off the Supabase CLI

Until ADR 0020 the local database ran in the Supabase CLI stack, on the same ports. A database created there is carried over once, never reset, in two steps, because both listen on 127.0.0.1:54322. Only the `app` schema moves (every table and the migrations journal, as in "Backups"); Supabase's own schemas do not exist on a plain Postgres. The dump comes from the Supabase container's Postgres 17 tools and is restored by the compose container's Postgres 18 tools, which read older dumps. Accounts and files were already moved off Supabase Auth and Storage when sign-in and files left Supabase, so nothing else needs copying.

```bash
pnpm db:import-from-supabase --dump-only     # read-only: pg_dump of app from supabase_db_<project>, into the OS temp directory
supabase stop --project-id sortea            # keeps the Supabase data volume; never add --no-backup
pnpm db:start                                # the compose Postgres takes 54322
pnpm db:import-from-supabase --restore <file the first step printed>
```

The first step finds the running `supabase_db_<project>` container (`--container <name>` picks one when several run), counts the rows of `organizations`, `orders`, `admin_users` and `__migrations`, and writes `app.dump` with a manifest (`app.dump.json`: checksum and counts). The restore refuses a `DATABASE_URL` that is not on this machine, a dump that does not match its manifest, a `DATABASE_URL` that reaches another server than the compose container (the Supabase CLI still running), and a target that already has the `app` schema unless `--replace` is given. It replaces the schema in one transaction, compares the four counts and prints them, and deletes the dump only when they match; otherwise it keeps the file and exits with an error. `pg_dump`, `pg_restore` and `psql` run inside the containers. To go back, `pnpm db:stop` and `supabase start` bring the old database up again, unchanged.

### Back-office accounts

The API signs admins in itself (ADR 0020, docs/spec/SECURITY.md "Acceso al panel"): accounts live in `app.admin_users` with scrypt password hashes, sessions are opaque tokens in an httpOnly cookie, and the second factor is a TOTP authenticator app, required when `REQUIRE_ADMIN_MFA=true` (always in production). There is no public sign-up and no password recovery by email.

- The seed and `pnpm client:load` create local accounts with `SEED_ADMIN_PASSWORD`, only on a local database.
- The platform console lists and creates accounts at `/admin/plataforma/usuarios`, and can create an organization's owner with the organization. A new account gets a temporary password, shown once, that the panel asks to replace at the first sign-in. Anyone signed in changes their own password at `/admin/contrasena`, which ends their other sessions.
- An operator manages accounts of the database at `DATABASE_URL` from the command line; it prints that database first, and the generated password is the only secret it ever prints:

```bash
pnpm admin:user create <email> [--platform-admin]   # the first platform administrator of an environment
pnpm admin:user reset-password <email>              # new temporary password; ends every session
pnpm admin:user reset-mfa <email>                   # removes the authenticator app; ends every session
pnpm admin:user disable <email>                     # blocks the account; ends every session
```

The seed is additive: on a database that already has data it creates Taller Demo and Pista Sur only when they are missing and never changes another organization's rows. Taller Demo takes `localhost`, `127.0.0.1` and `demo.localhost`, skipping any host another organization already has; the seed prints the address it got.

Payments run against a **local simulator** (`PAYMENTS_FAKE_PROVIDER=true`): checkout redirects to `/pago-simulado`, and approving there sends a signed notification through the real webhook path. To test real Mercado Pago sandbox credentials, set `PAYMENTS_FAKE_PROVIDER=false`, load the credentials in the platform console and expose the API with a tunnel so Mercado Pago can reach `API_PUBLIC_URL`.

To rehearse the seeded demo campaign end to end while its approvals are pending, set `COMPLIANCE_DEMO=true` (never in production, which refuses it). The waiver applies only while the organization's active Mercado Pago account is the simulator or a Mercado Pago test account; with a production account nothing is waived. Campaigns marked as demo can then be opened from the admin, the shop shows their chances and every public page carries a demonstration notice. Approvals are never written (ADR 0013).

To try a real Mercado Pago sandbox payment locally, with or without the demo mode:

1. Set `PAYMENTS_FAKE_PROVIDER=false` in `.env` and restart the API.
2. Create a test seller and its application as in [docs/launch/mercadopago-setup.md](docs/launch/mercadopago-setup.md) ("Step 1"), and connect its `APP_USR-` token and webhook secret in the platform console (`/admin/plataforma/<organization>`) with Entorno **Sandbox (pruebas)**. The console shows "Cuenta de prueba de Mercado Pago" when Mercado Pago reports a test user; only then does the demo mode apply.
3. Buy in a private window, as a guest, with a test card and a made-up test-style email such as `test_user_4821@testuser.com`. Signing in to a real Mercado Pago account, or using a real email, makes Mercado Pago refuse the payment.
4. Mercado Pago cannot notify `localhost` without a tunnel, so the order stays pending after the payment: open `/admin/conciliacion` and press "Conciliar ahora", then "Aplicar estado de Mercado Pago" on the missing payment. With a tunnel set as `API_PUBLIC_URL`, the webhook confirms it instead.

`pnpm db:reset` drops and rebuilds the local database (local hosts only).

### Files

Product files and site media live in one private S3-compatible bucket per environment, under `product-assets/` and `site-media/` (`backups/` is reserved for database dumps), reached through the AWS SDK with the `S3_*` variables (ADR 0020, "Files"). Locally that is MinIO from `docker-compose.yml`, with the defaults of `env.template`; `pnpm setup:env --force` adds them to an existing `.env`. Stored paths stay `<organizationId>/...` without the prefix, so the database is the same with any bucket. Downloads redirect to a one-minute presigned URL; the site links library images and videos as `/media/<path>`, which redirects to a presigned URL of the bucket (see "Deploy").

### World locations

The checkout suggests countries and provinces from our own copy of [GeoNames](https://www.geonames.org) (CC BY 4.0); the city is typed by hand, and the imported cities stay in the database for later use (ADR 0012). `pnpm db:geo` downloads `countryInfo.txt`, `admin1CodesASCII.txt` and `cities1000.zip` into `.cache/geonames/` the first time and imports them; running it again updates the same rows. `pnpm db:geo <dir>` imports the files from another directory instead. It uses `DATABASE_URL`, so run it in each environment after `pnpm db:migrate`. Without it, the checkout offers only Argentina and the province and city are plain text fields.

Location data © GeoNames, licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).

### Product files

The seed puts a one-page sample PDF behind each digital product, and so does `pnpm client:load` on a local database when a client's real file is missing; a deployed database never gets a sample (see "Client packs"). A real file can also be pushed on its own under `product-assets/` of the bucket with:

```bash
pnpm db:product-file <organization-slug> <product-slug> <file> [--name <download-name>]
```

It uses `DATABASE_URL` and the `S3_*` variables, so it works the same locally and against a deployed environment; it prints the database and the bucket first. The download name defaults to the file's name and may only use letters A-Z, digits, dots, dashes and underscores. Only PDF and ZIP files are accepted, and only for digital products with at most one file. A product that already has a file keeps it as the same record, so download links buyers already received deliver the new file; the previous object is deleted about a minute later (65 s), once the download URLs signed for it have expired, so a buyer downloading during the swap still gets it. Running it again with the same file and download name changes nothing, unless storage lost that file: then it is uploaded again (`Restored`, audited as `product.file_restored`). Relative paths are read from the directory the command runs in. Each change is recorded in the audit log (`product.file_added`, `product.file_replaced`).

A digital product's image is its cover: the shop card shows its top (where the title is) and the product page shows it whole. A client's covers are files of its pack (`clients/<client>/static`, see "Client packs"), so they ship with the private repository's web builds.

### Client packs

A client's content (brand, theme, contact, site blocks, catalog, demo campaign, legal drafts), its images and its notes live in its own pack, `clients/<client>/`, which exists only in the private repository and is never published. Shared code and tests use the fictional Taller Demo instead, so no client is hardcoded (AGENTS.md). A pack is `clients/<client>/pack.ts` (a `ClientPack` from `packages/db/src/client-pack.ts`), plus `static/` for its images and a README with its operational notes.

```bash
pnpm client:export <client>                   # writes the local database's content and files into the pack
pnpm client:upload-files <client>             # uploads the pack's files to a deployed bucket (S3_* from the environment)
pnpm client:load <client>                     # creates the organization when it is missing
pnpm client:load <client> --update            # refreshes the content of the organization with the same slug
pnpm client:load <client> --update --catalog  # also creates and updates its products and their files
pnpm client:load <client> --update --campaign # also adds the pack campaign, as a draft, when it is missing
pnpm client:load <client> --host <hostname>   # binds this host instead of the pack's list
```

`client:load` uses `DATABASE_URL` for the organization and its local accounts (`SEED_ADMIN_PASSWORD`), and the `S3_*` variables for the product files (it creates the bucket only on a local database with a local endpoint), and prints the database, the bucket and the host it binds. It never touches another organization and never grants an approval: the pack's demo campaign is created with its legal and payment approvals pending, by the same function as a campaign created in the admin (`createCampaign` in `packages/db/src/campaigns.ts`, used by `POST /admin/campaigns`). Without `--update`, an existing organization is left as it is. With it, the name, settings, theme and site blocks are refreshed, each changed block as a new published version (a legal text needs a new version, as in the site editor). `--catalog` (only with `--update`) also creates the pack's missing products and updates the existing ones by slug: name, description, image, position, price, variant names and missing variants. A new product is created active, or as a draft out of the shop when the pack marks it `status: 'draft'` (one the client still has to finish). It never deletes a product or variant, keeps the status of existing products and the stock of existing variants (the shop's own state), never changes a product's kind, and never touches suggestions, campaigns or orders; a product whose declared file differs gets it as with `pnpm db:product-file` (same asset row, previous object deleted after 65 s). `--campaign` (only with `--update`) adds the pack's campaign as a draft, built like one created in the admin with its approvals pending, when the organization has no campaign with its slug; a person reviews it, records the approvals and opens it in the admin. An existing campaign, members and hosts are never changed by an update. Hosts another organization already has are skipped. The pack's local accounts and the payment simulator are added only on a local database.

**Exporting.** `pnpm client:export <client>` reads the organization with the client's slug from the local database, in a read-only transaction, and rewrites in `clients/<client>/pack.ts` only the values that differ: name, order prefix, settings (contact, social, delivery, legal versions), theme, every published CMS block (legal texts in their published version; unsaved editor drafts are ignored), the active products with their variants, prices and images, the suggestions' pitches, the site FAQs, and `files`. Comments, consts and formatting are kept, and a second run without database changes leaves the file byte for byte. It prints what changed per section. It never reads orders, buyers, entries, payments, integrations, audit events, members or sessions, and never exports campaigns: the pack's `campaign`, `hosts` and `members` are written by hand and stay as they are. It refuses a database or bucket that is not on this machine.

**Real product files.** The export maps each digital product to its file (`files: { <product>: { filename, sha256, contentType } }`) and copies the bytes from the local bucket to `clients/<client>/files/<first 16 hex digits of the sha256>-<filename>`. That directory is in `.gitignore` and `.public-exclude`: the files are kept outside git, on the machine that ran the export, and the next export copies them again from the local bucket. `client:load` gives each new digital product its declared file, checking its sha256, from that directory or from the bucket's `product-assets/_incoming/<sha256>`. On a local database a missing file falls back to the sample PDF (and the command says so). On a deployed one, a missing or undeclared file refuses the whole load, which then writes nothing. A file whose sha256 differs is refused everywhere.

**Loading a deployed environment.** Its database is private, so `client:load` runs inside its api service ("Deploy"), whose image has no `files/` directory. The files go through the bucket:

1. On the owner's machine, with the local stack running: `pnpm client:export <client>`, review `git diff clients/<client>/pack.ts`, commit and deploy, so the api image carries the pack.
2. On the same machine, with that environment's bucket credentials set only in the command's environment (never in a file; this command does not read `.env`): `pnpm client:upload-files <client>` with `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` and `S3_FORCE_PATH_STYLE`. It checks every file against the pack's sha256 and uploads each to `product-assets/_incoming/<sha256>`, skipping those already there.
3. Inside the api service: `node dist/client-load.js <client> --host <domain>` (or `--update --catalog` for an existing organization). It copies each file from `_incoming/` to its product's path, checking the sha256, creates the `product_assets` rows, and removes the `_incoming/` copies it used. A mismatch refuses the load and leaves the upload in place for inspection.

The web serves every `clients/*/static` directory as if it were in `apps/web/static` (`apps/web/plugins/client-static.ts`), so a client's images keep their `/tenants/<client>/...` URLs in development and in the private repository's builds; the public copy has no `clients/`, so it serves none.

## Tests

```bash
pnpm check                 # TypeScript and Svelte checks
pnpm test                  # domain, db, api and worker against real Postgres (the compose one)
pnpm gate                  # what CI runs, plus the compiled pre-deploy on a throwaway database (see "Deploy")
E2E_ADMIN_PASSWORD=... pnpm test:e2e   # Playwright against the running stack
```

The suites create their throwaway databases (`sortea_test_db`, `sortea_test_api`, `sortea_test_worker`) on the compose Postgres from `pnpm db:start`, through `TEST_DATABASE_ADMIN_URL` (default `postgresql://postgres:postgres@127.0.0.1:54322/postgres`), and never touch the `postgres` database itself. Set `TEST_DATABASE_SUFFIX` (letters, digits, underscore) to run the suites of several checkouts at once, for example in git worktrees: each gets `sortea_test_api_<suffix>` and so on.

Two opt-in suites need local services: `S3_TEST_ENDPOINT=http://127.0.0.1:9000` runs the object store against MinIO, and adding `BACKUP_TEST=1` runs the backup and restore round trip (`packages/db/test/backup-restore.integration.test.ts`), which also needs the PostgreSQL 18 client tools on `PATH` or in `PG_BIN_DIR`. Without them, run it in a container with those tools (for example the worker image's `build` stage with `postgresql-client-18` added), pointing `TEST_DATABASE_ADMIN_URL` and `S3_TEST_ENDPOINT` at `host.docker.internal`. Both use throwaway databases and their own bucket prefix, and remove them.

The E2E suite checks what buyers see against the state of the seeded campaign, which you declare: leave `E2E_CAMPAIGN_OPEN` unset for the seed's state (approvals pending, no chances promised), or set `E2E_CAMPAIGN_OPEN=1` (or `true`) when that campaign is open; any value other than `1`, `true`, `0` or `false` stops the run (for example with `COMPLIANCE_DEMO=true` after opening it from the admin). A page that shows another state fails the run instead of being trusted. Without `E2E_ADMIN_PASSWORD` the admin tests are skipped.

The API suite covers the acceptance criteria of the PRD, among them: ten duplicate webhooks confirm once (AC-01), tenants cannot read or write each other (AC-02), browser returns never confirm (AC-03), secrets never leave the API (AC-05), multi-prize campaigns with independent awards, alternates and deliveries (AC-06), lookups resist enumeration (AC-07), reconciliation detects missing payments, different amounts, refunds and settlement discrepancies (AC-09), the dashboard resyncs after losing its connection (AC-04), rules cannot be rewritten silently (AC-08), the manifest hash is recomputable (AC-11) and campaigns cannot open without approvals (AC-12). Rate limits live in memory, so restart the API between repeated E2E runs.

## Deploy

Pending account and configuration steps are tracked in [docs/launch/environment-setup.md](docs/launch/environment-setup.md). The decisions behind this section are in ADR 0020.

### Images

Each service has a Dockerfile, the portable artifact (ADR 0020, "Portability"). The build context is always the repository root:

```bash
docker build -f apps/api/Dockerfile -t sortea-api .
docker build -f apps/worker/Dockerfile -t sortea-worker .
docker build -f apps/web/Dockerfile --build-arg MEDIA_PUBLIC_ORIGIN=https://<bucket origin> -t sortea-web .
```

| Image | Start | What it holds |
| --- | --- | --- |
| api | `node dist/main.js`; pre-deploy `node dist/predeploy.js` | The API compiled to JavaScript, the migrations, the operator commands (below) with the client packs compiled in, and the PostgreSQL 17 client. Health check `GET /health`. |
| worker | `node dist/main.js` | The worker compiled to JavaScript, the backup commands and the PostgreSQL 18 client. No port. |
| web | `node build` | The SvelteKit build (adapter-node) with the client packs' static files. Health check `GET /healthz`. |

All three run Node 22 on Debian 13 (`node:22.23.4-trixie-slim`, pinned by digest), as the unprivileged `node` user, with `NODE_ENV=production` and only production dependencies. No value from `.env` or any secret is in an image; everything comes from the environment at run time. The only build-time value is the web's `MEDIA_PUBLIC_ORIGIN`, which is not secret and goes into the CSP (ADR 0009).

The API and the worker are compiled with esbuild (`pnpm --filter @sortea/api build`, `pnpm --filter @sortea/worker build`, `scripts/bundle.mjs`): each entry is bundled with the workspace packages it uses, while packages from `node_modules` stay imports. The build fails when an app imports a package that is not in its own `dependencies`, because the image installs only those. `pnpm dev` still runs the sources with `tsx watch`.

The API listens on `::`, which takes IPv6 (Railway's private network, `<service>.railway.internal`) and IPv4, and falls back to `0.0.0.0` on hosts without IPv6; `API_HOST` names one address instead. It listens on `API_PORT`, else on the `PORT` the platform injects.

Operator commands in the api image (the worker has the three backup ones), run inside the service because the database has no public address:

```bash
node dist/admin-user.js create <email> --platform-admin   # pnpm admin:user
node dist/client-load.js <client> --host <domain>         # pnpm client:load
node dist/geo.js                                          # pnpm db:geo (downloads into GEONAMES_CACHE_DIR)
node dist/backup.js | node dist/backups.js | node dist/restore.js ...   # pnpm db:backup | db:backups | db:restore
node dist/migrate.js | node dist/erase-org.js ...                       # pnpm db:migrate | db:erase-org
```

### Railway

One Railway project per client, `sortea-<client>`, with one `production` environment, plus the shared `sortea-staging`; all in the workspace `sortea-clients` (ADR 0020, "Hosting model"). Each project has the same five pieces:

| Service | Source | Config file path | Network | Health check |
| --- | --- | --- | --- | --- |
| `web` | this repository, root directory empty | Dockerfile `apps/web/Dockerfile` | Public: Railway domain and the client's custom domains | `/healthz` |
| `api` | this repository, root directory empty | Dockerfile `apps/api/Dockerfile` | Private, plus a Railway domain used only for `/webhooks/*` | `/health`; pre-deploy `node /app/apps/api/dist/predeploy.js` |
| `worker` | this repository, root directory empty | Dockerfile `apps/worker/Dockerfile` | Private, no domain | none |
| `Postgres` | Railway's Postgres template (PostgreSQL 18 as of 2026-11) | — | Private only: remove its public TCP proxy | — |
| `Bucket` | Railway Bucket | — | Private; files are read only through presigned URLs | — |

Railway retired Config as Code (`railway.json`) for new services in 2026-11, so each service's settings are set on the service itself (dashboard or the Railway MCP `update-service`): the Dockerfile path above; watch paths (`web`: `apps/web/**`, `packages/domain/**`, `clients/*/static/**`; `api`: `apps/api/**`, `packages/**`, `clients/*/pack.ts`, `scripts/bundle.mjs`; `worker`: `apps/worker/**`, `packages/**`, `scripts/bundle.mjs`; all three also `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `.dockerignore`); health check `/healthz` (web) and `/health` (api), timeout 120 s; the api's pre-deploy command `node /app/apps/api/dist/predeploy.js`; restart on failure, 10 retries; and `PORT` 3000 (web) and 3001 (api) to match their domains. Leave each service's root directory empty: the Dockerfiles need the whole repository as their context. The images carry the PostgreSQL 18 client, whose `pg_dump` reads servers of version 18 and older.

Variables per service. `${{...}}` are Railway reference variables, so no value is copied by hand; `${{shared.X}}` is a project-level shared variable. Secrets (`SECRETS_KEY_RING`, `LOOKUP_PEPPER`, `PSEUDONYM_PEPPER`, `INTERNAL_API_TOKEN`) are generated once per project and are never the same in two projects.

| Variable | api | worker | web |
| --- | --- | --- | --- |
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` | `${{Postgres.DATABASE_URL}}` | — |
| `PORT` | `3001` | — | (Railway's) |
| `API_INTERNAL_URL` | — | `http://${{api.RAILWAY_PRIVATE_DOMAIN}}:${{api.PORT}}` | same as the worker |
| `INTERNAL_API_TOKEN` | `${{shared.INTERNAL_API_TOKEN}}` | same | same |
| `SECRETS_KEY_RING`, `LOOKUP_PEPPER` | `${{shared.…}}` | same | — |
| `PSEUDONYM_PEPPER` | `${{shared.PSEUDONYM_PEPPER}}` | — | — |
| `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | the bucket's reference variables (see "Files") | production projects only, for the nightly backup | — |
| `S3_FORCE_PATH_STYLE` | `true` only for a path-style bucket | same as the api | — |
| `MEDIA_PUBLIC_ORIGIN` | — | — | the origin the api logs at start; build and run time |
| `API_PUBLIC_URL` | `https://${{RAILWAY_PUBLIC_DOMAIN}}` | — | — |
| `WEB_FALLBACK_ORIGIN` | `https://<the client's domain>` | same | — |
| `DEPLOY_ENVIRONMENT` | `production` or `staging` | same | — |
| `REQUIRE_ADMIN_MFA` | `true` | — | — |
| `PAYMENTS_FAKE_PROVIDER` | `false` | — | `false` |
| `EMAIL_PROVIDER`, `RESEND_API_KEY`, `EMAIL_FROM_DOMAIN` | — | `resend`, the key, the verified domain ("Email (Resend)") | — |
| `WORKER_POLL_MS`, `RECONCILE_INTERVAL_MINUTES` | — | production `5000` and `60`; staging `30000` and `360` | — |
| `BACKUP_ENABLED`, `BACKUP_HOUR_UTC` | — | production `true` and `6`; staging unset | — |
| `BODY_SIZE_LIMIT` | — | — | `52M` (ADR 0009) |
| `ADDRESS_HEADER`, `XFF_DEPTH` | — | — | `X-Forwarded-For`, `1` |
| `HOST_HEADER`, `PROTOCOL_HEADER` | — | — | `x-forwarded-host`, `x-forwarded-proto` |

**The api's public domain.** Mercado Pago must reach `/webhooks/*`, so the api has a Railway domain; Railway cannot publish only some paths, so the whole API answers on it. Every route except `/webhooks/*` and `/health` refuses requests without the internal token (`401 internal_only`), which only the web and the worker hold; webhooks are checked by their signature, and `/health` answers `{ "ok": true }` or `503 { "ok": false }`, nothing else. The risk that remains is the token: if it leaks, the API is open from the internet, so it is generated per project, kept only in the shared variable and rotated if exposed (rotating it is a change the owner approves). Do not add a custom domain to the api.

**Pre-deploy.** Before each api release takes traffic, Railway runs `node /app/apps/api/dist/predeploy.js` in the new image. Under a Postgres advisory lock (two releases never migrate at once) it checks for pending migrations; when there are any and the database already has the schema, it first dumps the database as a `pre-migrate` backup into the bucket, then migrates. A failed backup or migration exits 1 and the release does not start; the previous one keeps serving. `PREMIGRATE_BACKUP=false` skips the dump, for a host whose database has backups of its own.

**First steps of a new project**, once the three services are green:

```bash
railway ssh --service api        # a shell in the running api (or the service's shell in the dashboard)
node dist/admin-user.js create <email> --platform-admin   # the first platform administrator (prints a temporary password once)
node dist/geo.js                                          # reference data, once
node dist/client-load.js <client> --host <domain>         # client projects: the client's organization from its pack
```

`railway run` runs a command on your machine with the service's variables, and your machine cannot reach `postgres.railway.internal`, so these commands run inside the service. A pack can be loaded only by an image built from the private repository (it compiles `clients/<client>/pack.ts`).

**Branches.** The `staging` branch deploys to `sortea-staging`, and `main` to every client project. A release is merged into `staging`, tried there, then merged into `main`. CI (`.github/workflows/ci.yml`) runs on pull requests and on pushes to both. While GitHub Actions is off, `pnpm gate` runs the same checks locally before merging: `pnpm check`, the unit and integration suites, the script tests, the API and worker builds, and the compiled pre-deploy on a throwaway database `sortea_gate`, which it creates on the server of `DATABASE_URL` and drops at the end. It refuses a server that is not on this machine.

Staging's `web` and `api` may sleep when idle (Railway's serverless setting); the worker must not.

### Backups

Railway's own database backups come only with the Pro plan, so the platform dumps its database itself (ADR 0020, "Backups of our own"). A dump is `pg_dump -Fc --schema=app` streamed into the project's bucket as `backups/<DEPLOY_ENVIRONMENT>/<UTC time>-<reason>.dump` (for example `backups/production/20261110T060012Z-nightly.dump`) with a `.sha256` sidecar; credentials travel to `pg_dump` as libpq variables and are never printed. The reason is `nightly` (the worker), `pre-migrate` (the pre-deploy) or `manual`.

- **Schedule.** With `BACKUP_ENABLED=true` (only `true` or `false` are accepted; any other value stops the worker at start), the worker checks every ten minutes and dumps when the bucket has no nightly dump since today's `BACKUP_HOUR_UTC` (default 6, 03:00 in Argentina). The bucket's listing is the record, so a restarted worker never dumps twice for one night, and one that was down at that hour catches up once. Only a dump with its `.sha256` sidecar counts: a dump cut short before its sidecar (restore refuses it) is taken again at the next check. Run one worker per project.
- **Retention**, applied after every dump: the newest 14 nightly dumps, the newest 8 nightly dumps taken on a Sunday, and every `pre-migrate` and `manual` dump of the last 30 days stay; the newest dump always stays, and files under `backups/` that are not dumps are never touched. A dump without its sidecar counts for nothing and is deleted once it is an hour old; `pnpm db:backups` marks it as incomplete.
- **Staging** has no nightly dump (`BACKUP_ENABLED` unset, and its worker gets no bucket credentials): its data is test data, every migration release still takes a `pre-migrate` dump, and the restore rehearsal takes a manual one.

```bash
pnpm db:backup [--reason manual]          # dumps DATABASE_URL into the S3_* bucket, then applies the retention
pnpm db:backups                           # lists backups/<DEPLOY_ENVIRONMENT>/, newest first
pnpm db:restore <key> --target <database URL> --confirm <database>@<server> [--i-know-this-is-production]
```

A restore checks the dump against its sidecar first, then replaces the target's `app` schema in one transaction (it drops the schema and runs the dump's script with `ON_ERROR_STOP`), so a failed restore leaves the target as it was. Before anything else it asks the target who it is: its database name and its server's `system_identifier` (`pg_control_system()`). `--confirm` must repeat both as `<database>@<last 6 digits of the identifier>`; run it once without `--confirm` and the refusal prints the target's host, database and server, so the operator confirms the server they mean. Every Railway database is called `railway`, so the server part is what tells staging from production. If the role may not read the identifier, `--confirm` takes the database name alone and a note says so. In production (`DEPLOY_ENVIRONMENT=production`) it refuses the environment's own database, recognised by the same identity, so the host's IP or another spelling of its name does not pass, without `--i-know-this-is-production`; when that identity cannot be read (`DATABASE_URL` is not set or does not answer, or a server will not give its system identifier), it cannot tell the databases apart, so it refuses every target without `--i-know-this-is-production` and prints a note saying why. Restore into another database first and compare. A failed restore reports psql's or pg_restore's error and removes its temporary copy of the dump. If the dump is older than the release, run the migrations against the target afterwards. In a deployed project, run them in the api or worker service (`node dist/backups.js`, `node dist/restore.js <key> --target "$DATABASE_URL" --confirm railway@<server>`). Locally they need the PostgreSQL 17 client tools (`pg_dump`, `pg_restore`, `psql`) on `PATH` or in `PG_BIN_DIR`.

### Files

Create one Railway Bucket per project and map its credentials to the `S3_*` variables, preferably as reference variables of the bucket rather than copied values: on the **api**, and on the **worker** of production projects for the nightly backup. The web never gets them. Railway Buckets are private, which is what the platform expects: every file is read through a presigned URL.

| Bucket credential | Variable |
| --- | --- |
| Endpoint | `S3_ENDPOINT` (empty only for AWS S3 itself) |
| Region | `S3_REGION` |
| Bucket name | `S3_BUCKET` |
| Access key ID | `S3_ACCESS_KEY_ID` |
| Secret access key | `S3_SECRET_ACCESS_KEY` |
| URL style | `S3_FORCE_PATH_STYLE`: `true` for `https://endpoint/bucket/key`, `false` (default) for `https://bucket.endpoint/key` |

The **web** needs `MEDIA_PUBLIC_ORIGIN`, the origin of the bucket's presigned URLs, at build time and at run time: the `S3_ENDPOINT` origin with path style, `https://<S3_BUCKET>.<endpoint host>` with virtual-hosted style. The API logs the origin it signs for when it starts ("Files are served from the S3 bucket"), so copy it from there. Downloads (`/descargas/<token>`) and `/media/<path>` redirect only to that origin, and the CSP allows it in `img-src` and `media-src`; a build without it warns and uploaded images and videos do not load.

- Downloads: the API checks the buyer's token and answers a presigned GET of `product-assets/<path>` valid for 60 seconds, served as an attachment with the product's file name. Push the files with `pnpm db:product-file` (see "Product files"); up to 100 MiB, PDF or ZIP.
- Site media: the site links library files as `/media/<organizationId>/<sha256>.<ext>`. The web asks the API (internal token, the host decides the organization) and answers `302` to a presigned GET of `site-media/<path>`. URLs are signed once per 12-hour window aligned to UTC and stay valid 24 hours from its start, so a file keeps the same URL within a window; the redirect carries `Cache-Control: public, max-age=<seconds until the window ends>` and the object `public, max-age=31536000, immutable`. Videos play from the bucket, which answers their `Range` requests, so files never travel through our services (bucket egress is free, service egress is billed). The API keeps images at 2 MB and videos at 50 MB.

The web service needs `BODY_SIZE_LIMIT=52M` so video uploads pass through the BFF; a guard in the web keeps every other route at 3 MB (ADR 0008, ADR 0009).

Production requires `REQUIRE_ADMIN_MFA=true`, `PAYMENTS_FAKE_PROVIDER=false`, `EMAIL_PROVIDER=resend` and secrets generated per environment (`SECRETS_KEY_RING`, peppers, `INTERNAL_API_TOKEN`). The API refuses to start in production with the simulator or without MFA, and the worker refuses SMTP there. The API connects to Postgres directly over the private network: the live dashboard uses `LISTEN`, which needs a session connection, never a transaction pooler (ADR 0007). Each custom domain is added in the platform console and pointed to the web service.

### Erasing an organization

Only on the owner's explicit request, and irreversible: backups are the only recovery (ADR 0011). It uses `DATABASE_URL`, so check which database it points to.

```bash
pnpm db:erase-org <slug>                    # dry run: rows per table and files per prefix of the bucket
pnpm db:erase-org <slug> --confirm <slug>   # erases the rows, then the storage files
pnpm db:erase-org <slug> --confirm <slug> --skip-storage   # rows only, when storage credentials are not at hand
```

It uses the `S3_*` variables to list and delete `product-assets/<organizationId>/` and `site-media/<organizationId>/` after the rows are gone. It refuses organizations with Mercado Pago in production mode unless `--allow-production` is added, and records `organization.erased` in the platform audit log.

### Email (Resend)

One platform Resend account sends every email: lookup codes, purchase confirmations with the chances' numbers and download links, and refund notices. Each email shows the organization's name as the sender.

1. In Resend, add the sender domain (for example `sortea.com.ar`) and create the DKIM, SPF and return-path records it lists in your DNS. Wait until Resend shows the domain as verified.
2. Create an API key with sending access only, restricted to that domain. One Resend account can hold several domains (the Free plan includes 3), and a key restricted to a domain cannot send from the others, so this platform's email stays separate from other projects in the same account.
3. On the worker, set `EMAIL_PROVIDER=resend`, `RESEND_API_KEY` and `EMAIL_FROM_DOMAIN` to the verified domain. Emails go out from `"<Organization>" <no-reply@EMAIL_FROM_DOMAIN>`.
4. Request a lookup code from `/consulta` and confirm it arrives.

The worker retries rate limits and server errors with backoff and sends each retry with the same idempotency key, so a buyer never gets two copies. A message Resend refuses for good (an invalid address, an unverified sender, a revoked key) goes straight to dead letter with Resend's reason in `outbox_events.last_error`. Locally, `EMAIL_PROVIDER=smtp` delivers to Mailpit instead: nothing reaches a real inbox, and every email (with its styles and download links) is at http://localhost:54324.

## Organization images

`apps/web/static/tenants/taller-demo` holds Taller Demo's images: placeholders generated from plain shapes and openly licensed photos credited in the `CREDITS.md` next to them. A client's images live in its pack (`clients/<client>/static`). The site editor can replace any of them with uploaded images. Prize photos and videos are added per campaign; the campaign page shows a typographic placeholder until a real photo exists, by design.

## Publishing the public copy

The private repository is the one that is developed and deployed; the public repository gets a copy without client packs or working notes, as one commit on top of its own history (ADR 0021).

```bash
pnpm publish:public --dry-run        # checks the snapshot of HEAD, fetches and commits nothing
pnpm publish:public [--target main] [--remote public]
```

It takes the committed `HEAD` (uncommitted changes are not published), leaves out every path in `.public-exclude` (`clients/`, `odd/` and local tool state) and refuses the snapshot when any file still mentions a client: the name of each `clients/<client>/` directory, written with or without spaces or dashes, the terms in its `clients/<client>/publish-forbidden.txt` (other spellings, phone, handles) and the owner's personal data in `clients/publish-forbidden.txt`, plus any CUIT or CUIL number with a valid check digit. It lists each match as `file:line` and commits nothing. Otherwise it fetches the target branch from the `public` remote, commits the snapshot on top of it as `chore: publish <private short sha>` on the local branch `publish/<target>`, and prints the push command (`git push public publish/main:main`). It never pushes: review the commit, then push it.
