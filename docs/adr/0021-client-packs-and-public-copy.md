# ADR 0021: Client packs and the public copy

Status: accepted, 2026-11-09 (task R2 of the Railway infrastructure work). Complements ADR 0020, "Hosting model".

## Context

The platform is developed and deployed from a private repository, and a public repository keeps a generic copy (ADR 0020). Until now the shared code carried the first client: the seed created it with its real brand, contact, social profiles, site texts, catalog and legal drafts, its images sat in `apps/web/static`, and tests, end-to-end tests and docs used its name, phone and links. Publishing would have needed a manual cleanup every time, and the owner's instruction is that the public repository must hold nothing of a specific client while the private one keeps all of it: "Si el hecho de eliminar desde montesgp/sortea todo lo que tenga que ver con un cliente especifico lo tenemos que hacer si o si. Pero preservar todas esas imagenes y data para el repo privado en [a private account]."

## Decision

- **Shared code is client-neutral.** The seed creates the fictional "Taller Demo" (slug `taller-demo`) with the structure of a real client (brand, theme, contact, CMS blocks, legal drafts, four products, a demo campaign with pending approvals, local accounts) and made-up data, plus the fictional second tenant Pista Sur. Its images are generated placeholders or openly licensed photos with credits. Every test uses Taller Demo or neutral data.
- **A client is a pack.** `clients/<client>/` holds `pack.ts` (a `ClientPack`, `packages/db/src/client-pack.ts`), `static/` with its images, its documents and a README with its operational notes. The seed's organizations are packs too (`packages/db/src/packs`), loaded by the same code.
- **Loading is additive.** `pnpm client:load <client>` creates the organization when it is missing and binds the first of its hosts that no other organization has. An existing organization is left alone unless `--update` is passed; then only its name, settings, theme and CMS blocks are refreshed, each block as a new published version with its revision and legal texts under a new version, as the site editor does. Catalog, campaigns, members and hosts of an existing organization, and every other organization, are never touched. Approvals are always created pending: a pack has no field for them (ADR 0015). The seed follows the same rule, so it can run on a database that already has a client: Taller Demo then takes `demo.localhost`.
- **Client images keep their URLs.** The web serves every `clients/*/static` directory as part of its static files, in development and in builds (`apps/web/plugins/client-static.ts`), so `/tenants/<client>/...` works where the pack exists and nothing is served where it does not.
- **The public copy is generated, never edited.** `pnpm publish:public` takes the tree of `HEAD`, removes the paths in `.public-exclude` (`clients/`, `odd/`, local tool state), refuses it when any file mentions a client (each `clients/<client>` name and the terms in its `publish-forbidden.txt`), the owner's personal data (`clients/publish-forbidden.txt`) or a CUIT or CUIL number, and otherwise commits it as one commit on top of the public branch. It does not push; a person reviews and pushes. The public history stays as it is.

## Consequences

- Publishing is one command and the check runs every time, so a client mention in shared code is caught before it leaves, not after.
- The private repository's builds include the clients' images; a deployment per client (ADR 0020) can later build with only its own pack if the others' images should not ship with it.
- Tests and end-to-end tests describe the fictional organization. A database that already holds a client gets Taller Demo on `demo.localhost`, so end-to-end runs point `E2E_BASE_URL` there.
- `--update` does not migrate catalog or campaign changes; those stay in the admin, where prices, stock and locked rules are protected.
