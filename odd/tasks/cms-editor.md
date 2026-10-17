# CMS editor (FR-CMS-04)
Admin editor for the public site content: drafts, publish, revisions, public media uploads, FAQs, legal texts, SEO, banner and video.
Branch: main (owner pushes directly; push needs the owner's go-ahead). Infra (cloud buckets, deploy, GitHub) is out of scope: the owner does it.

## Specs
S1: PRD FR-CMS-04 "CMS para imágenes, video URLs, banners, copy, SEO/OpenGraph, FAQs, legales, ganadores y evidencias de entrega." Winners and delivery evidence are already managed by the award console (AC-06); this feature covers the rest.
S2: Images: "Subida a un bucket público (recomendado)" — "El panel sube el archivo por la API a un bucket público de Supabase Storage, separado del bucket privado de descargas. Lo dejo configurado en local (config.toml y seed); crear el bucket en la nube queda para tu parte de infraestructura."
S3: "toda la parte de infra esperame a mi, porque aun vamos a estar necesitando varios cambios y armar todo el flujo y gestionar github y demas" — no deploy, CI, GitHub or cloud resource changes; document what production will need.
S4: AGENTS.md: "Business rules live in `packages/domain` and the API. The web tier is SSR plus a thin BFF; it never holds secrets or decides prices." / "Every new business table carries `organization_id` and gets `app.apply_tenant_policy('<table>')` in its migration." / "Do not hardcode MotoGarage (or any tenant) in shared code. Brand experiences are switched by CMS content." / "Never invent legal authorizations" (legal texts are tenant-authored; seeds keep the existing draft notice).
S5: Design decisions (agent, from PRD/ADR patterns): edits go to a draft and are published explicitly; each publish appends a revision (append-only) and is audited; publishing a legal text sets the policy version used for checkout consents; images are sniffed by content (JPEG, PNG, WebP; no SVG), capped in size, stored under the tenant's own prefix; only `cms.manage` (owner, admin) edits.

## Tasks
T1 [S1,S4,S5] inline; done; domain: block schemas, media sniffing, FAQ input, legal version rule; commit 0d79d6e.
T2 [S2,S4,S5] inline; done; db: draft/revisions/media tables + RLS, local public bucket and seed; commit 8c557c9.
T3 [S1,S2,S5] inline; done; api: cms.manage, drafts/publish/revisions, media upload, FAQs, public site payload; commit d9398dc.
T4 [S1,S2,S4] inline; done; web: /admin/sitio editor, media library, public banner/SEO/legal/video rendering + CMS E2E; commits a544730 (fix textareas), 0a604cb (api versions), 526e3b9.
T5 [S1-S5] inline + verify; done; README, ADR 0008, production notes, independent verification and its fixes; commits 1dab858, 0615365.

## Log
L1: "Hagamos push y sigamos con lo pendiente, toda la parte de infra esperame a mi, porque aun vamos a estar necesitando varios cambios y armar todo el flujo y gestionar github y demas"
L2: Owner chose image handling: "Subida a un bucket público (recomendado)".
L3: Pushed main 51e7fc2..f49de7d before starting.
L4: T1 RED 12/12 (missing module), then RED for `//host` links; GREEN domain suite 86/86, tsc clean. Commit 0d79d6e.
L5: T2 RED (missing cmsBlockRevisions), GREEN db suite 14/14, repo check clean, scripts 7/7. Migration 0006 applied to local dev DB (additive); seed now ensures buckets before its "already seeded" exit, site-media bucket exists locally. Existing local blocks have no v1 revision (seeded earlier). Commit 8c557c9.
L6: T3 RED 15/15 (no routes) then GREEN; extra RED for checkout reading the cached legal version (another instance publishes) then GREEN. API suite 97/97, repo check clean. Checkout now reads organization settings in its transaction (shared code change, covered by the new test and the existing payment suites). Commit d9398dc.
L7: T4 cms-form RED (missing module) then GREEN 5/5. Found and fixed: site FAQs were never rendered (now on home); BFF site cache hid fresh publishes (invalidate on publish); Svelte SSR drops textarea defaultValue (pre-existing in 6 admin pages; RED with JS disabled in catalog E2E, fixed with TextArea component, commit a544730); sitio page load made 9 API calls and hit the 300/min rate limit in the full E2E (versions now in GET /admin/cms). Full E2E 22/22, web unit 24/24, API cms 16/16. Leftover E2E data from failed runs cleaned (2 FAQs, 3 media rows+objects, 1 product archived).
L8: gentle-ai-verify: S1-S5 met, no blockers; D1 (old legal version reusable for other text), D2 (duplicate FAQ questions crash home), D3 (legal label from tenant cache) fixed with RED->GREEN (domain, API, E2E), plus A2 (loopback CSP dev-server only, prod build checked), A3 (empty FAQ PATCH 400), A5. A1/A4 recorded in ADR. pnpm check 0; tests domain 87, web 24, db 14, api 98, worker 7, scripts 7; E2E 21/22 + flaky reconciliation login rerun 3/3. Native assess: medium, reviewDue false (no native review). Commit 0615365.
