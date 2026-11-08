# ADR 0013: A local demo mode rehearses demo campaigns while approvals are pending

Status: accepted, 2026-10-20. Amended 2026-11-07: Mercado Pago test accounts may run the demo too (see the amendment below).

## Context

AC-12 keeps a campaign from opening until its legal and PSP approvals are recorded with evidence, and FR-CAMP-05 shows chances only for a campaign that accepts participations. AGENTS.md forbids inventing approvals, and the seed keeps them `pending`. As a result, the seeded demo campaign can never be tried end to end: the participate button stays disabled and the shop shows no chances. The owner asked to rehearse it locally "so it looks real" while the real approvals are pending.

Writing approved records with made-up references would break the rule, and those records would survive into any database they were copied to.

## Decision

- **One local switch.** `COMPLIANCE_DEMO=true` in the API's environment. The configuration refuses it when `NODE_ENV=production`. Until 2026-11-07 it also required the payment simulator; the amendment below replaces that rule with a check of the active account, so no real payment can earn chances under waived approvals.
- **Only demo campaigns.** The waiver applies to campaigns marked `is_demo`. Other campaigns keep the normal gate, with or without the switch.
- **Pending only.** The gate waives missing approvals but never a rejected one. `missing` is still reported, and the gate result says `demo: true`.
- **Nothing is written.** Approval rows are not touched. The switch is read through `campaignGate`, which every caller (admin transitions, shop, quote, checkout, payment confirmation, reconciliation) now receives explicitly.
- **Always visible.** While the waiver can apply (switch on and a test account active, see the amendment), every public page shows "Demostración — sin validez legal ni pagos reales". The campaign's Autorizaciones section and the admin campaign page also say that the approvals are pending and waived by the demo mode.

## Consequences

- The seeded demo campaign can be opened from the admin and bought from the shop with the simulator. Chances are highlighted and numbered as in a real campaign.
- Turning the switch off closes the gate again. An already open demo campaign stops accepting participations: late payments keep the purchase and earn nothing (`entries.not_allocated`), as with any campaign outside its gate. Entries allocated during the demo remain in the local database. `pnpm db:reset` clears them.
- Deployed environments must never set `COMPLIANCE_DEMO`. Production refuses to start with it.
- The owner's paper attestation (ADR 0015) is a different thing: a real approval a person records, not a waiver. The demo mode never writes one, and the seeded demo campaign keeps its approvals pending.

## Amendment 2026-11-07: Mercado Pago test accounts

Owner decision: "¿Permitimos el modo demo (chances sin aprobaciones) también con cuentas de PRUEBA de Mercado Pago verificadas, nunca con productivas?" — "Sí". The owner wants to rehearse real Mercado Pago sandbox payments locally, and later on staging, with Mercado Pago test accounts.

- **The account decides, not the simulator switch.** `COMPLIANCE_DEMO` no longer needs `PAYMENTS_FAKE_PROVIDER=true`; production still refuses it. The waiver applies only when the switch is on, the campaign is marked `is_demo`, and the organization's **active** Mercado Pago account is the simulator or a test user verified by Mercado Pago. With a production account the switch changes nothing: chances need real approvals, exactly as without it.
- **Mercado Pago says which accounts are test users.** Connecting, reactivating and verifying an account call `GET /users/me`; a test account lists `test_user` in its `tags` (for example `["user_product_seller", "test_user", "normal"]`). The answer is stored in the account's public config (`testUser`, and `simulator` for the simulator's accounts) and refreshed at every check. The platform console shows "Cuenta de prueba de Mercado Pago" next to such an account. Nobody can mark an account as a test account by hand.
- **One rule, read every time.** `campaignGate` reads the active account through `demoPayments` (`apps/api/src/lib/campaign-state.ts`) on every evaluation: admin detail, opening and reopening, the shop, the quote, checkout, confirmation and reconciliation. Switching to a production account removes the waiver at once; an order started on the test account and paid afterwards keeps the purchase and earns nothing (`entries.not_allocated`).
- **Defense in depth at confirmation.** When the waiver applies, chances are granted only if the order's pinned account and the account that confirmed the payment are both test accounts. Otherwise the purchase stands and `entries.not_allocated` records `demo_requires_test_account`.
- **Said as it is.** The demo banner and the admin gate notice say "pagos de prueba de Mercado Pago" instead of "pagos simulados" when the active account is a real test account.

Why it is safe: a test user's money is fictitious, like the simulator's; Mercado Pago itself states which accounts are test users, so the platform invents nothing; a production account never gets the waiver, at the gate or at confirmation; and production refuses the switch. Approvals are still never written, and seed and demo data keep them `pending`.

Consequences: accounts connected before this amendment carry no `testUser` and get no waiver until they are verified or reactivated. A test seller only accepts test buyers (docs/launch/mercadopago-setup.md). The public campaign page's Autorizaciones text still mentions simulated payments while in demo; it is outside this change.
