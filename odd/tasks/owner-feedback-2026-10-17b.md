# Owner feedback round 5 (2026-10-17): login, admin exposure, theme speed, organization erasure

Password visibility on the admin login, protection of /admin/login against bots, faster tenant theme, and an operator-only safe erasure of an organization.
Security questions are answered from evidence in the closing report.

## Specs

- S1 Password eye: "Agregar ojo en passwrord del login." The admin login password field has a show/hide toggle.
- S2 Login against bots: "El admin esta oculto al sitio publico cierto? Ademas esta facil de atacar en internet? Muchos bots atacan las rutas /wp_admin por wp atacan /admin/login por ruta comun etc. No nos afecta el hacking en este punto, tenemos buena seguridad en backend?" Sign-in attempts are throttled per client and per account in the web tier, so bots cannot guess passwords at speed nor exhaust Supabase's per-IP limit (which sees only the web server's IP) and lock every admin out. Admin responses carry `X-Robots-Tag: noindex`.
- S3 Theme speed: "El multi-theme esta yenbdo al backend? Podemos ser mas rapidos en eso?" No page waits for the site/theme request while a cached copy exists: an expired entry is served at once and refreshed in the background.
- S4 Safe erasure: "Intentenmos tener un borrado seguro para cuando sucedan casos que yo estrictamente lo pida." An operator-only command (no UI, no API) erases one organization: dry run by default with row counts; it runs only with the exact slug confirmed; it refuses organizations with production Mercado Pago credentials unless explicitly overridden; it removes every row of that organization (including append-only tables) and its storage files, and leaves a platform-level audit record.
- S5 Cleanup now: "Este caso no hay problema si borramos cualquiera que no sea motogarage. Son todas de prueba las demas." Erase every local organization except MotoGarage.

## Tasks

- T1 [S1] inline; done; password eye on /admin/login; commit "panel sign-in resists guessing bots".
- T2 [S2] inline; done; login throttle + noindex header + ADDRESS_HEADER docs; same commit.
- T3 [S3] inline; done; stale-while-revalidate site cache; same commit.
- T4 [S4] gentle-ai-worker (background); pending; erase-organization command + tests + ADR 0011 + README; commit -.
- T5 [S5] inline after T4 and its verification; pending; run the command for every organization except motogarage; commit -.
- T6 [S2, S4] gentle-ai-verify (risk items 1 and 2); pending.

## Log

L1: "Agregar ojo en passwrord del login. El admin esta oculto al sitio publico cierto? Ademas esta facil de atacar en internet? Muchos bots atacan las rutas /wp_admin por wp atacan /admin/login por ruta comun etc. No nos afecta el hacking en este punto, tenemos buena seguridad en backend? El multi-theme esta yenbdo al backend? Podemos ser mas rapidos en eso? Intentenmos tener un borrado seguro para cuando sucedan casos que yo estrictamente lo pida. Este caso no hay problema si borramos cualquiera que no sea motogarage. Son todas de prueba las demas"
L2: Evidence before work. Login posts from the web server to Supabase Auth (`apps/web/src/lib/server/admin-session.ts:30-44`); Supabase's sign-in limit is per IP (`supabase/config.toml:207`, 30 per 5 min) and only ever sees the web server's IP, and the web has no throttle of its own, so a bot can both guess at 30/5 min and lock all admins out. The public site has no link to /admin; admin pages carry `<meta name="robots" content="noindex">`. API: global rate limit 300/min per IP (`apps/api/src/app.ts:60`), tokens verified by the API, RBAC, RLS. Theme: `/public/site` answers in ~25 ms and the web caches it per host (`apps/web/src/lib/server/site.ts`, 2 s dev / 30 s prod); a dev SSR page takes ~250 ms, mostly Vite dev mode. Erasure: `organization_id` FKs are `restrict`, 9 tables have append-only triggers (migrations 0001, 0003, 0004, 0006), storage paths start with `<organizationId>/`.
L3: T1-T3 inline. RED: login-throttle and site-cache modules missing; E2E login.e2e against the stashed old code failed (no eye, no x-robots-tag). First site cache draft passed the request context through a module variable, which could cross tenants under concurrent requests; replaced by a loader per call before commit. Per-client limit set to 30 failures/15 min so repeated local E2E runs do not lock 127.0.0.1. Found ADDRESS_HEADER/XFF_DEPTH missing from deploy docs (without them every visitor shares the proxy's address); added to SECURITY.md and docs/launch/environment-setup.md. GREEN: web unit 77/77, svelte-check 0, E2E login+admin+mfa 9/9.
