# Owner feedback round 7 (2026-10-18): products shown on the campaign and the home

The campaign page and the home choose which products they show from the back office; with no choice they show every active product, like the shop.
The per-order limit question is answered from evidence; no change asked.

## Specs

- S1 Per-order limit: "Puede ser que el limite de compra de productos sea 5? Eso porque? Manejamos stock o algo?" Answer only: "Máximo por compra" per variant (default 5, editable in the product's variant) and stock per variant are separate controls.
- S2 Campaign products: "En los productos que mostramos dentro de http://localhost:5173/sorteos/tornado-300 que seria la campaa, estaria faltando la remera en el caso de motogarage. Pero eso debe ser configurable desde el backoffice. Que se muestra en esa seccion." The campaign editor chooses the products its page shows; with none chosen the page shows every active product (so the T-shirt shows today).
- S3 Home products: "Tambien en la home veo solo 3 productos de la tienda, unifiquemos como el paso anterior." The site editor chooses the products the home shows; with none chosen the home shows every active product.

## Tasks

- T1 [S2] inline; done; campaign product selection (migration 0009, API, editor, page); commit "each campaign chooses the products its page shows".
- T2 [S3] inline; done; home product selection (CMS home block, editor, page); commit "the home shows the products chosen in the site editor".

## Log

L1: "1. Puede ser que el limite de compra de productos sea 5? Eso porque? Manejamos stock o algo? 2. En los productos que mostramos dentro de http://localhost:5173/sorteos/tornado-300 que seria la campaa, estaria faltando la remera en el caso de motogarage. Pero eso debe ser configurable desde el backoffice. Que se muestra en esa seccion. 3. Tambien en la home veo solo 3 productos de la tienda, unifiquemos como el paso anterior."
L2: Evidence: maxPerOrder default 5 per variant (packages/db/src/schema.ts:451), editable as "Máximo por compra" (admin productos/[id]/+page.svelte:51); stock per variant (schema.ts:450). Campaign page shows products whose variants grant chances in the locked rules, else the first 3 (sorteos/[slug]/+page.server.ts:14,21); the T-shirt grants no chances in tornado-300. Home shows catalog.slice(0, 3) ((site)/+page.server.ts:20). Design: empty selection = all active products, in catalog order.
L3: T1: migration 0009_campaign_products (product_ids uuid[] default {}), PATCH accepts productIds (deduped, must be products the organization sells: 400 unknown_product otherwise), admin detail lists the active catalog, public detail exposes productIds; editor section "Productos en la campaña"; page uses shownProducts (chosen in catalog order, else all). T2: CMS home block productIds (default [], deduped uuids), editor fieldset "Productos en la página de inicio" fed by the public catalog, home uses shownProducts. RED: API 4/4, domain 2, cms-form 2, shown-products missing. GREEN: API 193/193, domain 131/131, web 103/103; E2E shown-products 3/3, cms + campaign-first + chances + admin 15/15 (chances failed once at sign-in, then 4/4 on repeat). S1 answered only: per-variant "Máximo por compra" (default 5) and stock are separate controls.
