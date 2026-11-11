# ADR 0020: Railway-only infrastructure (Postgres, buckets, own admin sign-in)

Status: accepted, 2026-11-09 (odd/tasks/railway-infrastructure.md). Supersedes the Supabase parts of ARCHITECTURE.md, PRD.md ("Cerradas") and ADRs 0001, 0005, 0007, 0008, 0009 and 0011, as listed under "What changes elsewhere".

## Context

The platform was planned on Railway for `web`, `api` and `worker`, with a Supabase Cloud project per environment for three things: PostgreSQL, Storage (product files and site media) and Auth (back-office sign-in with TOTP MFA). Nothing is deployed yet, so no data has to move.

The owner decided (2026-11-09): "no quiero ir a supabase ... quiero postgresql pero en railway tal como lo hacemos con [another project of the owner's] asi mantengo todo en la misma infra y red local. Mejor seguridad, mejor latencia mas facil de administrar." Railway must also hold the files: "storage para poder colgar los documentos manuales digitales, y algun video del sorteo y de la moto. Como tambien imagenes del producto a sortear. Simplemente eso no mucho mas."

Two environments, `staging` and `production`, each with its own database, as in the owner's other Railway projects. Traffic is low: a store with a draw.

Facts checked on 2026-11-09:

- Railway Buckets are S3-compatible and **private only**. Files are served through presigned URLs or a backend. Storage costs $0.015 per GB-month; bucket egress and S3 operations are free, while service egress is billed.
- Railway Postgres runs on a volume with scheduled backups (daily kept 6 days, weekly kept 27 days, monthly kept 89 days), billed like volume storage.
- Railway bills usage (RAM, CPU, egress, volumes, backups) on every plan; the plan fee is a floor that includes the same amount of usage. A comparable project of the owner's estimates about $6 a month.

## Decision

### Database

- **One Railway Postgres service per environment**, reached by the API and the worker over Railway's private network (`*.railway.internal`); the database has no public proxy. `DATABASE_URL` is a Railway reference variable, never a copied value.
- The schema, row-level security per organization (`app.apply_tenant_policy`, `db.withTenant`) and the live dashboard's `LISTEN` work unchanged on standard Postgres. The `REVOKE` of Supabase roles in migrations 0001 and 0008 is guarded by `IF EXISTS` and stays harmless.
- **Migrations run as the API's pre-deploy command** (`pnpm db:migrate`), so a release never starts against an old schema and nobody runs them by hand. Reference data (`pnpm db:geo`) runs once per environment.
- **Backups of our own.** Railway's built-in database and volume backups come only with the Pro and Enterprise plans (pricing page, checked 2026-11-09), and the platform starts on Hobby. A scheduled job dumps each production database with `pg_dump` every night into a `backups/` prefix of that project's bucket and keeps the last 14 nightly and 8 weekly dumps; every migration release takes one more dump before it migrates. Restoring a dump on staging is rehearsed before launch and after any change to the job. The dumps work on any host, unlike volume snapshots. If the workspace moves to Pro, Railway's daily and weekly backups are added on top, not instead.
- Production never runs the seed. A bootstrap command creates the first platform administrator and nothing else; organizations are created from the platform console.
- **As built (deploy, 2026-11-10).** The api's pre-deploy is `node dist/predeploy.js` of its image: under a Postgres advisory lock it lists the pending migrations and, when there are any on a database that has the schema, takes the `pre-migrate` dump before migrating; a failed dump or migration stops the release. Dumps are `pg_dump -Fc --schema=app` streamed into `backups/<DEPLOY_ENVIRONMENT>/<UTC time>-<reason>.dump` with a `.sha256` sidecar (`packages/db/src/backups.ts`, `backup-runner.ts`). The worker takes the nightly dump from `BACKUP_HOUR_UTC` (default 06:00 UTC) when the bucket has none since that hour, so restarts never dump twice; retention keeps the newest 14 nightly, the newest 8 Sunday nightly, every `pre-migrate` and `manual` dump of 30 days, and always the newest. `pnpm db:restore` checks the sidecar, replaces the `app` schema in one transaction, needs the target's database name and the last digits of its server's `system_identifier` typed back, and refuses the production database itself, recognised by server identity rather than by host name, without `--i-know-this-is-production`. A dump counts, for the schedule and the retention, only with its sidecar. Staging takes no nightly dump (test data; its `pre-migrate` and manual dumps remain), so only production workers hold the bucket's credentials. Commands and variables: README, "Deploy".

### Files

- **One Railway Bucket per environment** holds both kinds of file under prefixes: `product-assets/` (paid downloads: PDF and ZIP, up to 100 MiB) and `site-media/` (images up to 2 MB, videos up to 50 MiB). The upload limits stay those of ADRs 0008 and 0009; the 50 MB Supabase Free limit no longer applies, so the first client's 61 MB manual fits.
- **Downloads** keep their design: the API checks the buyer's token and redirects to a short-lived presigned URL (today a Supabase signed URL).
- **Public media** is addressed by the site as `/media/<key>`. The web answers with a redirect to a presigned URL, so images and videos travel from the bucket (free egress, `Range` requests for video) and never through our services (billed egress). The presigned URL is computed for a fixed time window, so the same file keeps the same URL within it and browsers can cache it. The CSP allows the bucket's endpoint origin for `img-src` and `media-src`.
- Only the API writes to the bucket; its credentials never reach the browser or the web service's client code.
- **As built (2026-11-09).** One module, `packages/db/src/object-store.ts` (AWS SDK v3, path-style or virtual-hosted addressing), serves the API, `pnpm db:product-file`, `pnpm db:erase-org`, the seed and `pnpm client:load`. The API reads `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` and `S3_FORCE_PATH_STYLE`, one per credential of a Railway Bucket; the web reads only `MEDIA_PUBLIC_ORIGIN`, the origin of the presigned URLs, for its redirect check and its CSP. Stored paths are unchanged (`<organizationId>/...`); the module adds the prefix, so no data migration exists. Downloads are presigned for 60 seconds with the file name as attachment. Media URLs are signed once per 12-hour window aligned to UTC and stay valid 24 hours from its start; the `/media/<path>` redirect is cached until its window ends. The API signs only library paths (`<organizationId>/<sha256>.<ext>`) of the organization the host resolves to.

### Back-office sign-in

Supabase Auth is replaced by sign-in owned by the API. Only back-office users sign in: there is no public sign-up and no buyer account (buyers keep the guest checkout and the lookup by email code).

- **Users** live in a platform table (email, password hash, status), keeping today's user ids, so `organization_members` and the platform roles stay as they are.
- **Passwords** are hashed with scrypt from Node's standard library (no native dependency), with per-user salt and parameters stored with the hash so they can be raised later.
- **Sessions** are opaque random tokens kept in an `httpOnly`, `Secure`, `SameSite=Lax` cookie by the web. The database stores only a hash of the token, its assurance level (password only, or password plus TOTP), absolute and idle expiry, and is the source of truth: signing out or disabling a user ends its sessions at once. This replaces the JWT and JWKS verification.
- **MFA** keeps its contract: TOTP (RFC 6238), mandatory in production (`REQUIRE_ADMIN_MFA`), with the secret sealed with `SECRETS_KEY_RING` and a code accepted at most once.
- **Throttling** per account and per address stays in front of the password check (SECURITY.md, "Acceso al panel"), and failed and successful sign-ins are audited.
- **Recovery** at launch is a platform administrator's job: a command resets a user's password or MFA. Self-service "forgot my password" by email is out of scope until it is asked for.
- **As built (2026-11-09).** Migration `0018_admin_sign_in` adds `app.admin_users` (unique lowercased email, `scrypt$N=32768,r=8,p=1$<salt>$<key>` hash, status, `must_change_password`, sealed TOTP secret, confirmation time and last accepted step), `app.admin_sessions` (SHA-256 of a 32-byte token, `password` or `mfa`, absolute expiry 12 hours, idle expiry 30 minutes, revocation, address and shortened user agent) and `app.admin_sign_in_throttle`. They have no `organization_id` and no grant to `sortea_app`; RLS is on with no policy. The API's routes are `POST /auth/sign-in`, `GET /auth/session`, `POST /auth/sign-out`, `POST /auth/totp/enrol|confirm|verify|cancel` and `POST /auth/password`; every admin route looks the bearer session up (`apps/api/src/lib/admin-auth.ts`). Each throttle counts an attempt before the password or code is checked, in one upsert per key, and gives it back on success, so concurrent requests cannot outrun the limits; code checks and password changes also hold the user row. A confirmed code ends the password-only session and returns a new `mfa` token with the same absolute expiry, and a new sign-in ends the session the browser held (verification of T4, 2026-11-10). The platform console lists and creates users (`/platform/users`, `/admin/plataforma/usuarios`), sets their optional alias (migration `0019_admin_user_alias`, owner feedback 2026-11-10) and creates an organization's owner with it; a new account gets a temporary password shown once. `pnpm admin:user create|reset-password|reset-mfa|disable <email>` bootstraps (`create --platform-admin`) and recovers accounts. The seed and `pnpm client:load` create local accounts in `admin_users`; a one-time `pnpm auth:import-supabase-users` copied the local Supabase users, keeping their ids, and was removed with the local Supabase stack ("Local development"). The QR code is drawn by the API with the `qrcode` package. Throttles, lifetimes and audit entries are in SECURITY.md, "Acceso al panel".
- **Remembered devices (2026-11-10).** After a correct TOTP code the person may tick "Recordar este dispositivo por 30 días" (odd/tasks/launch-prep-2026-11-10.md, S1, L4). Migration `0021_admin_trusted_devices` adds `app.admin_trusted_devices` (SHA-256 of a 32-byte token, user, absolute expiry 30 days from creation, last use, revocation, shortened user agent), protected like `admin_sessions`. The code routes take `remember` and return the token once; the web keeps it in the httpOnly `sortea_admin_trusted` cookie on `/admin` and sends it with `POST /auth/sign-in`, where it is checked only after the throttle, the password and the account status, for the same user with a confirmed app, and turns the new session into `mfa`; a temporary password must still be replaced. Using it never extends it, and signing out keeps it. Recovery also forgets devices: a password change, `pnpm admin:user reset-password|reset-mfa|disable` and "Mi cuenta" (`GET /auth/trusted-devices`, `POST /auth/trusted-devices/forget`) revoke every device of the user. A stolen cookie therefore saves an attacker only the code, and only together with the password.

### Local development

A Docker Compose file replaces the Supabase CLI stack: Postgres, an S3-compatible store (MinIO) and Mailpit. Each existing local database is copied over once, with a dump and restore, never reset. MinIO came first (`docker-compose.yml`, `pnpm storage:up` and `pnpm storage:init`); since MinIO no longer publishes official images, it runs Chainguard's build from source (`cgr.dev/chainguard/minio`). The files of an existing local Supabase Storage were copied once with `pnpm storage:copy-from-supabase`, which ran only between local endpoints and skipped objects already copied.

- **As built (2026-11-10).** `docker-compose.yml` runs `postgres` (the official PostgreSQL 18.6 image, the major version of Railway's Postgres template, pinned by digest; user, password and database `postgres`; named volume `postgres-data` at `/var/lib/postgresql`, health check `pg_isready` over TCP), `mailpit` (`axllent/mailpit` v1.33.1 pinned by digest) and `minio`, every port on 127.0.0.1 and at the Supabase CLI's numbers (54322 Postgres, 54324 Mailpit, 54325 SMTP), so `DATABASE_URL`, `SMTP_PORT` and the test defaults did not change; `LOCAL_POSTGRES_PORT`, `LOCAL_MAILPIT_PORT` and `LOCAL_SMTP_PORT` move them for a second stack. `pnpm db:start` and `pnpm db:stop` (`scripts/local-stack.mjs`) run `docker compose up --detach --wait` and `docker compose stop` with the services named, since the Supabase CLI labels its containers with the same compose project, and start refuses while a `supabase_db_*` container holds the ports; `pnpm storage:up` is folded into `db:start`. `pnpm db:import-from-supabase` carries a database over in two steps (`--dump-only`, then `--restore <file> [--replace]`, README "Moving off the Supabase CLI"): a `pg_dump -Fc` of the `app` schema from inside the Supabase container, restored with the compose container's tools in one transaction, refused on a non-local `DATABASE_URL`, on one that reaches another server than the compose container, and on a target that already has `app` without `--replace`; it compares the counts of organizations, orders, admin users and migrations and deletes the dump only when they match. The Supabase CLI configuration (`supabase/`), `scripts/supabase.mjs`, `SUPABASE_URL`, `SUPABASE_SECRET_KEY` and the one-time `pnpm storage:copy-from-supabase` and `pnpm auth:import-supabase-users` are gone: both copies had run (every Supabase user had an account, every stored object was in MinIO), and neither can run without the Supabase stack.

### Portability

Railway is where the platform runs today, not a dependency of the code. The owner: "La idea es que sea postgress y que luego yo deploye donde me plazca. En este momento railway, en otro puede ser netlify por ejemplo, Clouflare, AWS, GCP etc." The code depends only on:

- **PostgreSQL 15 or later**, reached through `DATABASE_URL`, with a session connection (the live dashboard uses `LISTEN`, ADR 0007).
- **An S3-compatible object store** (Railway Buckets, AWS S3, Google Cloud Storage interoperability, Cloudflare R2, MinIO), reached through the S3 variables.
- **Email** through Resend, or SMTP outside production.
- **Three long-running Node 22 processes** (`web`, `api`, `worker`), configured only through environment variables, each with a Dockerfile in the repository as the portable artifact. Railway's configuration stays a thin layer over them (build, start, pre-deploy, health check).
- **As built (2026-11-10).** `apps/{web,api,worker}/Dockerfile` (context: the repository root; Node 22 on Debian 13 pinned by digest; non-root; production dependencies only; the api and worker add the PostgreSQL 18 client) and `apps/{web,api,worker}/railway.json` (Dockerfile builder, watch paths, health checks `/healthz` and `/health`, the api's pre-deploy, restart on failure). The api and the worker run JavaScript compiled by esbuild (`scripts/bundle.mjs`), with their operator commands in the image (`node dist/<command>.js`), since the database has no public address. The API listens on `::` for the private network, with a fallback to `0.0.0.0`.

No Railway-specific API is called from the code. Hosts that run long-lived containers fit as they are: Railway, Render, Fly.io, AWS (ECS, Fargate or App Runner with RDS and S3), Google Cloud (Cloud Run with a minimum of one always-on instance for the API and the worker, Cloud SQL and Cloud Storage), Azure, or a VPS with Docker. Serverless and edge hosts (Netlify, Cloudflare Workers, Vercel functions) do not run the API's open `LISTEN` connection or the worker's loop; there they could host at most the web, with a different SvelteKit adapter, while the API and the worker run elsewhere. Cloudflare R2 works as the object store from any host.

### Worker intervals

Set per environment through variables, no code change (owner, 2026-11-09: "ese mismo espaciado podemos tener en production y en staging espaciarlo aun mas"):

| Environment | `WORKER_POLL_MS` (pending emails) | `RECONCILE_INTERVAL_MINUTES` (Mercado Pago reconciliation) |
| --- | --- | --- |
| production | 5000 | 60 |
| staging | 30000 | 360 |

Reconciliation is a safety net behind the webhook, which confirms payments within seconds: it recovers lost notifications and late approvals, and brings refunds and chargebacks made from Mercado Pago's panel (ADRs 0006, 0018). Its interval is the longest a buyer whose notification was lost waits for their chances; "Conciliar ahora" runs it on demand.

### Hosting model: one installation per client

Decided by the owner on 2026-11-09, after weighing one shared installation against one per client: "Vamos con la opcion B ... el pago me encargo yo y una instancia o workspace en railway por cliente ... deberia quedar mi tarjeta vinculada ... despues la factura queda saldada por el pago mensual de servicio que me hacen."

- **One code base, one installation per client.** Every client runs the same repository. A fix is made once and reaches every client, because each client's project deploys from it (or from a release tag, to update clients one at a time). The code stays multi-organization (ADR 0001), so clients could later share an installation if that becomes cheaper.
- **One Railway project per client**, `sortea-<client>` (named after the client's slug), with a single `production` environment: its own `web`, `api`, `worker`, Postgres and bucket. Each client's data, database and bill are separate. Railway reports usage per project, so each client's cost is known exactly.
- **One shared staging project**, `sortea-staging`, where every release of the platform is tried with test organizations and Mercado Pago test accounts before it reaches clients. Clients have no staging of their own; their content already has drafts and previews in the CMS.
- **Workspace `sortea-clients`**, on the owner's card, holds every project of this product, apart from the workspace of the owner's other business. It starts on the Hobby plan, whose $5 includes $5 of usage, so a separate workspace costs almost nothing extra; the owner reviews it after a month of real use and moves to Pro if needed (Pro adds team members, 30-day logs and built-in backups). Projects can be transferred between workspaces with an active plan.
- **Repository:** a private repository is where the platform is developed and what Railway deploys. The public repository keeps a generic version without client content (brand assets, client seed content and working documents), refreshed from time to time; its history stays as it is.
- **Business model (future):** a commission per purchase that covers Railway, Mercado Pago, email and a margin. The fees and net that Mercado Pago reports per payment are already stored (ADR 0018), so the cost per purchase can be computed from them.

### Environments and cost

- Railway projects `sortea-staging` (staging) and one `sortea-<client>` per client (production), all in the workspace `sortea-clients`. The branch `staging` deploys to `sortea-staging`, and `main` to every client project.
- Expected cost at current traffic, from the comparable project, is about $10 to $15 a month for staging plus one client. Staging's `web` and `api` may sleep when idle, and the API should run compiled JavaScript instead of `tsx` to save memory. A usage limit and alerts are set on the workspace.

## Consequences

- One provider, one private network and one bill. The database is not reachable from the internet, and the latency between the API and the database drops to the private network's.
- **We own back-office authentication.** Supabase gave a tested implementation; ours has to be built, tested and verified independently, and its scope is kept small (few users, no sign-up, no email recovery). It is the riskiest part of this change and ships in its own work unit.
- **We own database operations:** backups, restores and Postgres upgrades are ours. A restore is rehearsed on staging before launch.
- Public media depends on a presigned redirect; if the bucket credentials leak, they are rotated (a destructive action that needs the owner's approval) and the redirects keep working with the new ones.
- Variables `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY` and `SUPABASE_SECRET_KEY` go away; the bucket's S3 variables (`S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_FORCE_PATH_STYLE`) come in, on the API (and, since the deploy work unit, on production workers for the nightly dump), and the web gets `MEDIA_PUBLIC_ORIGIN`. `STORAGE_BUCKET` and `MEDIA_BUCKET` are gone with the files work unit, `SUPABASE_PUBLISHABLE_KEY` with the sign-in work unit, and `SUPABASE_URL` and `SUPABASE_SECRET_KEY` with the local Supabase stack (an existing local `.env` may keep them; nothing reads them).

## What changes elsewhere

| Document | Change |
| --- | --- |
| ARCHITECTURE.md | Database, storage, sign-in and deployment sections point to this ADR. |
| PRD.md, "Cerradas" | "Supabase Cloud como DB/Storage/Auth" becomes Railway Postgres, Railway Buckets and the API's own sign-in. |
| SECURITY.md, "Acceso al panel" | The sign-in path and its throttle are described against the API's sign-in (done with the sign-in work unit). |
| ADR 0001 | The app schema is no longer exposed by any REST layer; the Supabase role revocation stays as a harmless guard. |
| ADR 0005 | Admin sign-in goes from the web to the API, not to Supabase. |
| ADR 0007 | The note about Supabase's transaction pooler no longer applies; the API connects to Postgres directly. |
| ADRs 0008 and 0009 | Public media lives in the Railway bucket under `site-media/` and is served through `/media/<key>`; `MEDIA_PUBLIC_ORIGIN` is the bucket's endpoint. |
| ADR 0011 | Erasure deletes files through the S3 API instead of the Supabase Storage API. |
| docs/launch/environment-setup.md, README | Deployment steps for Railway only. |
- **As built (Railway, 2026-11-10).** Railway's Postgres template now runs PostgreSQL 18, so the images carry the PostgreSQL 18 client (`pg_dump` 18 reads 18 and older) and the local Compose Postgres is 18 too. Railway retired Config as Code for new services, so the `railway.json` files were removed and each service's settings are set on the service (README, "Railway").
