# Environment setup checklist

Pending steps for when the deployed environment is set up on Railway.

Everything runs on Railway (ADR 0020): one project per client, `sortea-<client>` (environment `production`), and the shared `sortea-staging`, in the workspace `sortea-clients`. The exact services, config files and variables are in README, "Deploy"; this list is the order to set them up in. Railway changes are made by the parent agent through the Railway MCP and reported (service, environment, setting); anything destructive waits for the owner's approval.

## Project and services

- [ ] Create the project (`sortea-staging` first, then each `sortea-<client>`) in the workspace `sortea-clients`.
- [ ] Add Postgres from Railway's template (PostgreSQL 18 as of 2026-11; the images' `pg_dump` 18 reads 18 and older). Remove its public TCP proxy, so the database is reachable only over the private network (removing it is destructive in the Railway sense: ask the owner first).
- [ ] Add a Railway Bucket (section "Files" below).
- [ ] Add the services `web`, `api` and `worker` from the private repository, each with an empty root directory and the settings listed in README "Railway" (Railway no longer accepts `railway.json` for new services). Branch: `staging` for `sortea-staging`, `main` for client projects.
- [ ] Generate the project's secrets once (`SECRETS_KEY_RING` as `v1:<base64 of 32 random bytes>`, `LOOKUP_PEPPER`, `PSEUDONYM_PEPPER`, `INTERNAL_API_TOKEN`) as shared variables, never reused from another project or printed.
- [ ] Set each service's variables as in README, "Deploy" (table "Variables per service"), with reference variables (`${{Postgres.DATABASE_URL}}`, `http://${{api.RAILWAY_PRIVATE_DOMAIN}}:${{api.PORT}}`, `${{shared.INTERNAL_API_TOKEN}}`); `PORT=3001` and `DEPLOY_ENVIRONMENT` (`staging` or `production`) on the api.
- [ ] Worker intervals per environment (ADR 0020): production `WORKER_POLL_MS=5000` and `RECONCILE_INTERVAL_MINUTES=60`; staging `30000` and `360`.
- [ ] Domains: a Railway domain on `web` (plus the client's custom domain on client projects) and on `api` (only for Mercado Pago's `/webhooks/*`; no custom domain). No domain on `worker`.
- [ ] Deploy and check the logs: the api's pre-deploy prints "Migrations applied" on the first deploy, `/health` answers `{"ok":true}`, the web's `/healthz` answers `ok`, and the worker prints its start line with the intervals and the backup setting.
- [ ] Optional on staging only: let `web` and `api` sleep when idle (serverless). Never the worker.
- [ ] Set a usage limit and alerts on the workspace.

## Backups

- [ ] Client projects: on the worker, `BACKUP_ENABLED=true`, `BACKUP_HOUR_UTC=6`, `DEPLOY_ENVIRONMENT=production` and the bucket's `S3_*` variables. The first nightly dump runs within ten minutes of the first start; `node dist/backups.js` in the worker lists it.
- [ ] Staging: no nightly dump (decided 2026-11-10: test data, and every migration release still takes a `pre-migrate` dump). The staging worker gets no bucket credentials.
- [ ] Rehearse a restore on staging before launch and after any change to the backup code (T7): `node dist/backup.js` in the api, then `node dist/restore.js <key> --target <a scratch database URL>`, which prints the confirmation it needs (`<database>@<server>`), then the same with `--confirm <that value>`, and compare. The restore refuses the production database itself without `--i-know-this-is-production` (README, "Backups").

## Branches and the local gate

- [ ] Create the `staging` branch from `main` in the private repository; releases go to `staging` first and are merged into `main` after the staging check.
- [ ] While GitHub Actions is off, run `pnpm gate` before every merge into `staging` or `main` (README, "Deploy", "Branches").

## Web service

- [ ] On the Railway `web` service, set `ADDRESS_HEADER=X-Forwarded-For` and `XFF_DEPTH=1`, so the panel's sign-in throttle and the API rate limit see each visitor's address instead of the proxy's (docs/spec/SECURITY.md, "Acceso al panel").
- [ ] Put the panel behind Cloudflare Access (an `admin.` hostname with an email check before the login page; free up to 50 users), so bots never reach `/admin/login`.

## Back-office accounts

- [ ] After the first deploy of each project (the pre-deploy migrates), open a shell in the api service (`railway ssh --service api`, or the service's shell in the dashboard) and run `node dist/admin-user.js create <email> --platform-admin` once. The database has no public address, so `railway run` from a laptop cannot reach it. Check the database it prints first; it prints a temporary password once, which the panel asks to replace at the first sign-in, followed by the authenticator app (`REQUIRE_ADMIN_MFA=true`).
- [ ] Create every other account from the platform console (`/admin/plataforma/usuarios`, or the owner's email when creating the organization) and hand each temporary password over a private channel.
- [ ] Recovery is a platform administrator's job: `node dist/admin-user.js reset-password|reset-mfa|disable <email>` in that project's api service (`pnpm admin:user` locally; docs/spec/SECURITY.md, "Acceso al panel").

## Reference data

- [ ] After the first deploy, run `node dist/geo.js` once in the api service (`pnpm db:geo` in the image) to load countries, provinces and cities from GeoNames (CC BY 4.0, about 20 seconds). Without it the checkout only offers Argentina and accepts typed places (ADR 0012).

## Files (Railway Bucket)

- [ ] In each Railway project (`sortea-staging`, then each `sortea-<client>`), create one bucket. It holds `product-assets/` (paid downloads), `site-media/` (images and videos) and `backups/` (database dumps); nothing else is configured on it (README, "Deploy", "Files").
- [ ] On the **api** service (and on the **worker** of client projects, for the nightly backup), map the bucket's credentials, preferably as reference variables of the bucket: Endpoint → `S3_ENDPOINT`, Region → `S3_REGION`, Bucket name → `S3_BUCKET`, Access key ID → `S3_ACCESS_KEY_ID`, Secret access key → `S3_SECRET_ACCESS_KEY`, and `S3_FORCE_PATH_STYLE` to `true` only if the bucket uses path-style URLs. The web never gets them; check the exact reference variable names on the bucket's Credentials tab.
- [ ] Deploy the api and copy the origin it logs at start ("Files are served from the S3 bucket") into the **web** service's `MEDIA_PUBLIC_ORIGIN`; Railway passes it to the Dockerfile's build argument of the same name and to the running service. Redeploy the web. Its build must not warn "No https MEDIA_PUBLIC_ORIGIN".
- [ ] Set the same `MEDIA_PUBLIC_ORIGIN` on the **worker** service (optional; without it the purchase ticket shows the organization's name instead of an uploaded logo, because the worker follows the `/media/<key>` redirect only to that origin, ADR 0023) and redeploy the worker.
- [ ] Check a library image on the site: `/media/<path>` answers `302` to the bucket and the image loads; an uploaded video plays and seeks.

## Product files

- [ ] In the api service's shell, load the client with `node dist/client-load.js <client> --host <domain>` (the private repository's image has the pack compiled in). Each digital product's file still needs `pnpm db:product-file`, which reads a local file and the database: until there is a way to run it against the private database, decide with the owner how to reach it (for example a temporary TCP proxy, an approved and reverted change) (README, "Client packs" and "Product files"; the client's own commands are in its pack's README). Check the host each one prints first.
- [ ] Check that each digital product shows its cover; a client's covers come with its pack.
- [ ] Buy each product with a test card and open the download links from the confirmation email.

## Email (Resend)

- [ ] In Resend, add the sender domain (for example `sortea.com.ar`). Create the DKIM, SPF and return-path records it lists in DNS, then wait until Resend shows the domain as verified.
- [ ] Create a Resend API key with sending access only, restricted to that domain, and keep it in the password manager. The same Resend account can hold this domain next to another project's (the Free plan includes 3 domains); the domain-restricted key keeps them separate.
- [ ] On the Railway `worker` service, set `EMAIL_PROVIDER=resend`, `RESEND_API_KEY` and `EMAIL_FROM_DOMAIN` (the verified domain).
- [ ] Request a lookup code from `/consulta` and confirm it arrives from `"<Organization>" <no-reply@EMAIL_FROM_DOMAIN>`.

Locally, `EMAIL_PROVIDER=smtp` delivers every email to Mailpit at http://localhost:54324 instead of a real inbox; that is where to check the emails, their styles and download links before Resend is configured.

Details: README, "Email (Resend)".

## Payments (Mercado Pago)

Step-by-step guide, with where each value comes from: [mercadopago-setup.md](mercadopago-setup.md).

- [ ] Pending (owner, 2026-11-06): when the staging environment exists, connect both Mercado Pago accounts to the first client's organization from the platform console: the client's test application (Entorno Sandbox) and the owner's own test application as the second account, switched with "Cambiar de cuenta" / "Volver a usar esta cuenta" (ADR 0017). Production uses the production applications. Credentials go only into the console, never the repository.
- [ ] On the Railway `api` service, set `API_PUBLIC_URL` to its Railway domain (`https://${{RAILWAY_PUBLIC_DOMAIN}}`). The domain serves the whole API, but only `/webhooks/*` and `/health` answer without the internal token (README, "Deploy", "The api's public domain").
- [ ] Get the Mercado Pago credentials of each account the organization will use: for staging, a test application's (a test seller account's `APP_USR-` production credentials, Entorno Sandbox, with a test buyer account to pay); for production, the real account's production application (`APP_USR-`, Entorno Producción).
- [ ] In the platform console (`/admin/plataforma/<organization>`), copy the notification URL it shows into the Mercado Pago application's Configuración de webhooks (event: Order (Mercado Pago), plus Contracargos if offered; not Pagos), and copy the **Firma secreta** Mercado Pago shows there (not the Client Secret under Credenciales).
- [ ] In the same console, choose the mode, paste the access token and that secret, in "Firma secreta del webhook", and press "Conectar cuenta". Mercado Pago checks them before they are stored; the account shows as verified with its merchant id. Press "Simular notificación" in Mercado Pago's Webhooks and check that the active account shows "Firma válida"; "Firma rechazada" means the secret is wrong, fixed with "Actualizar credenciales". To move to another account, even during a campaign, follow "Switching accounts during a campaign" in the setup guide. To stop charging, "Desvincular cuenta" erases every account's credentials (refused while any of them has payments in progress).
- [ ] Set `PAYMENTS_FAKE_PROVIDER=false` on every deployed service. The configuration refuses the simulator in production.
- [ ] Do not set `COMPLIANCE_DEMO` on any deployed service. It is a local rehearsal mode (ADR 0013), and the configuration refuses it in production.
- [ ] Signed in to Mercado Pago as the test buyer before paying (a guest or a real account cannot pay a test seller), buy with a test card and confirm the order turns paid, the chances get numbers and the confirmation email arrives. Then switch the integration to production mode with the real account's `APP_USR-` credentials.

To try a real account from a local machine, set `PAYMENTS_FAKE_PROVIDER=false` (with it on, every token goes to the simulator) and point `API_PUBLIC_URL` to a public tunnel to the API, since Mercado Pago cannot reach `localhost`. Without webhooks, the next reconciliation run lists the payment as missing and a person applies it from `/admin/conciliacion`.

A campaign is created from the admin: "Nueva campaña" on `/admin/campanas` (roles with `campaigns.manage`: owner, admin, and platform staff). It starts as a draft that is neither public nor open, with its products' chances, version 1 of the rules in draft and its approvals pending. Its dates may wait ("Borrador · fechas a definir"): it is published or opened only once it has an opening and a closing. Prizes, rules, chances and approvals are then managed on the campaign's page.

Paid participations also need the campaign's compliance approvals (legal and Mercado Pago). People approve them with real documents: each one with its authority and reference, or, when the documents exist only on paper, the organization owner checks "Todas las aprobaciones están otorgadas y su documentación está en papel" on the campaign (ADR 0015). The system never marks them approved on its own (AGENTS.md, AC-12).

- [ ] Before recording a campaign's legal approval, resolve with counsel the open decision on a free way to take part (ADR 0016): DNU 274/2019 art. 14 prohibits draws whose participation depends on a purchase, and the platform has no free channel yet.
