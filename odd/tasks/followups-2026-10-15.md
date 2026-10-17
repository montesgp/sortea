# Follow-ups after owner feedback round 1 (2026-10-15)

Small fixes noted during the CMS editor and owner feedback work. The owner approved "push and continue" over this list.
Infra and deploy stay with the owner (no Railway, Supabase cloud or GitHub settings).

## Specs

- S1 Checkout: "los campos de dirección de envío no muestran el mensaje de error debajo." Every shipping field the server rejects (street, city, province, postal code) shows its message under the field, linked with `aria-describedby`, and the message clears when the buyer edits that field, like the other checkout fields.
- S2 Cart: "si falla la cotización de stock, se ocultan las líneas del carrito." When the quote fails (out of stock, over the per-order limit, unknown or unavailable product), the cart still lists its lines, says which line has the problem, and lets the buyer change the quantity or remove the line. Checkout stays unavailable until the quote is fine again.
- S3 CMS: "el esquema de URL de imagen acepta `//host`." A same-site image path must start with exactly one `/`; `//host/...` (protocol-relative, another host) is rejected with the existing "Ruta de imagen inválida" message, for products and CMS blocks alike.
- S4 CMS: "borrar una imagen no está bloqueado mientras alguien edita un borrador que la usa." Deleting an image and saving a draft (or publishing) that references it cannot both succeed: either the delete is refused with `media_in_use` or the save is refused with `unknown_media`.
- S5 E2E: "el test de login a veces falla porque hace clic antes de la hidratación." Reproduce first; fix the cause only if it reproduces, otherwise record the evidence and leave the test unchanged.

## Tasks

- T1 [S3, S4] inline; done; domain image path + media row lock on draft save/publish; commit 4a0a28c.
- T2 [S1] inline; done; checkout shipping field errors; commit 1c0de88.
- T3 [S2] inline; done; cart lines when the quote fails; commit 0c9695b.
- T4 [S5] inline; done; reproduced: logout race, not hydration; commit e0f5603.
- T5 [S3, S4] gentle-ai-verify; done; S3 met, S4 met, no blockers; regression tests commit 5eb17d6.

## Log

L1: "Si hace push y avanza" (reply to the pending list: push the 5 local commits, then work the small follow-ups).
L2: Pushed 0615365..c9fbda0 to origin/main. Local stack was down (Docker Desktop not running); started Docker Desktop for tests.
L3: Exploration: imageUrlSchema regex `^\/[A-Za-z0-9/_.-]{1,200}$` accepts `//host` (packages/domain/src/catalog-admin.ts:23). assertOwnMedia reads cms_media without a lock while DELETE locks the row FOR UPDATE then checks blocks (apps/api/src/modules/cms.ts:76-93,297-311). Checkout shows no `<p class="error">` for city/province/postalCode (checkout/+page.svelte). Cart `{:else if !quote.ok}` renders only errors and a link to /tienda (carrito/+page.svelte:139-145).
L4: T1 inline. RED: domain catalog-admin + cms (`//evil.test/...` accepted), API "does not save a draft pointing to an image being deleted" (200 instead of 400). Fix: regex `^\/(?!\/)`, assertOwnMedia selects only the referenced paths FOR SHARE. GREEN domain 96/96, API 117/117, tsc clean. ADR 0008 consequence updated. Commit 4a0a28c.
L5: T2 inline. RED e2e 'every shipping field...' (street had no accessible description) -> GREEN; one snippet renders the four address fields with error + aria-describedby. cart.e2e 10/10, layout+purchase 8 passed 1 skipped (admin password not set), svelte-check 0. Commit 1c0de88.
L6: T3 inline. RED e2e 'when a line cannot be bought...' (cookie cart: Remera M x7 over max 5 + deleted variant; page showed only generic messages) -> GREEN. Load builds problemLines (cookie lines + public catalog names + API error per variant); lines show reason, quantity + Actualizar when fixable, Quitar; checkout link hidden. lineName moved to packages/domain. Screenshots 1366/390 checked (mobile name row fixed). cart+layout+chances 16 passed 2 skipped (admin password), API 117, domain 96, web 36, svelte-check 0. Commit 0c9695b.
L7: T4 inline. Repro: reconciliation.e2e --repeat-each=8 (parallel workers): 'owner consults...' timed out 2/8 waiting for getByLabel('Email') with the page showing the dashboard: page.goto('/admin/login') right after clicking 'Cerrar sesión' aborted the logout POST, so the session survived. Not a hydration issue (login is a plain form post). Other 4 failures were 'Ya hay una conciliación en curso' from parallel repeats running reconciliation at once (correct busy guard; serial --workers=1 18/18). Fix: wait for the Ingresar button after logout. Parallel repeat-each=12 of the owner test: 12/12. Commit e0f5603.
L8: T5 gentle-ai-verify: S3 met (probes: //, backslash, %2F, whitespace variants rejected; every consumer covered), S4 met (delete-first -> unknown_media, save-first -> media_in_use under READ COMMITTED; no deadlock; FOR SHARE works under RLS); lineName move byte-identical. Advisories: S3 top-level zod message is the union 'Invalid input' (pre-existing, unchanged); dot segments stay on-site (pre-existing). Added the suggested guard tests (save-first DELETE -> 409, more off-site paths): domain 6/6 file, API cms 21/21. Commit 5eb17d6.
L9: Final run: pnpm test all green (domain 96, web 36, db 14, api 118, worker 8, scripts 7). E2E cms+catalog+gallery+cart 20/21: cms 'uploaded image becomes the link preview' failed; trace shows POST /admin/sitio?/save -> 429 (API rate limit 300/min per IP, all local E2E share 127.0.0.1), pre-existing environment issue. After a 65 s cooldown cms.e2e 5/5. Finding (not fixed): a 429 on the site editor save shows no message to the user. Native assess c9fbda0..HEAD: medium, reviewDue false.
