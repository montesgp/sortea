# ADR 0022: Deleting products nobody ordered, archiving the rest

Status: accepted, 2026-11-10 (odd/tasks/owner-feedback-2026-11-10.md, S10)

## Context

Products were only ever archived, from their detail page. The owner asked: "Deberia poder eliminar productos definitivamente desde la lista sin tener que acceder al detalle del producto." A product can be pointed to by orders (their items, receipts and download grants), by the published rules of a campaign (chances per variant) and by a campaign page (`campaigns.product_ids`). Deleting any of those would break a buyer's receipt or download, or a published rule.

## Decision

- **"Eliminar" on each row of the list**, in two steps, both server-rendered `POST`s that work without JavaScript. The first asks the API what will happen (`GET /admin/products/:id/removal`) and shows it; the second does it (`DELETE /admin/products/:id`). The rule is `productRemoval` in `packages/domain`.
- **Refused while a campaign may still sell it**: a draft, review, published or open campaign shows it or gives chances for its variants in any version of its rules. The API answers 409 `product_in_campaign`, naming the campaigns; the product leaves the campaign first, or is archived once the campaign closes.
- **Archived when something keeps pointing to it**: an order of any status, or the rules of a campaign that already ended. It leaves the shop and the main list, stays under "Archivados" and comes back as a draft with "Restaurar". Receipts, lookups and downloads keep working, because nothing they read is deleted.
- **Deleted for good otherwise**: the product, its variants, its offers (anchored to it or listing its variants) and its file rows, in one transaction under the product's row lock. Its files leave the bucket after the commit; a file left behind is harmless, a row without its file is not.
- **Audited**: `product.deleted` (slug, name, kind and how many variants, files and offers went with it), `product.archived` (previous status and reason). A refusal changes nothing and records nothing.

No migration: `product_status` already had `archived`.

## Consequences

- A deleted product cannot be restored; the confirmation says so. Its audit event keeps what it was.
- A product only sold in unpaid or expired orders is archived, not deleted: order items keep a foreign key to it.
- CMS content that listed a deleted product (the home page selection) keeps its id; the site shows only products that exist and are on sale, so it drops out.
