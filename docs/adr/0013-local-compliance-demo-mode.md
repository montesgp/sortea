# ADR 0013: A local demo mode rehearses demo campaigns while approvals are pending

Status: accepted, 2026-10-20

## Context

AC-12 keeps a campaign from opening until its legal and PSP approvals are recorded with evidence, and FR-CAMP-05 shows chances only for a campaign that accepts participations. AGENTS.md forbids inventing approvals, and the seed keeps them `pending`. As a result, the seeded demo campaign can never be tried end to end: the participate button stays disabled and the shop shows no chances. The owner asked to rehearse it locally "so it looks real" while the real approvals are pending.

Writing approved records with made-up references would break the rule, and those records would survive into any database they were copied to.

## Decision

- **One local switch.** `COMPLIANCE_DEMO=true` in the API's environment. The configuration refuses it when `NODE_ENV=production` and whenever the payment simulator is off (`PAYMENTS_FAKE_PROVIDER=false`). That way, no real payment can earn chances under waived approvals.
- **Only demo campaigns.** The waiver applies to campaigns marked `is_demo`. Other campaigns keep the normal gate, with or without the switch.
- **Pending only.** The gate waives missing approvals but never a rejected one. `missing` is still reported, and the gate result says `demo: true`.
- **Nothing is written.** Approval rows are not touched. The switch is read through `campaignGate`, which every caller (admin transitions, shop, quote, checkout, payment confirmation, reconciliation) now receives explicitly.
- **Always visible.** While the switch is on, every public page shows "Demostración — sin validez legal ni pagos reales". The campaign's Autorizaciones section and the admin campaign page also say that the approvals are pending and waived by the demo mode.

## Consequences

- The seeded demo campaign can be opened from the admin and bought from the shop with the simulator. Chances are highlighted and numbered as in a real campaign.
- Turning the switch off closes the gate again. An already open demo campaign stops accepting participations: late payments keep the purchase and earn nothing (`entries.not_allocated`), as with any campaign outside its gate. Entries allocated during the demo remain in the local database. `pnpm db:reset` clears them.
- Deployed environments must never set `COMPLIANCE_DEMO`. Production refuses to start with it.
