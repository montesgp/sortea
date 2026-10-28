# ADR 0010: Buyer data is kept, never deleted, and used for marketing only with opt-in

Status: accepted, 2026-10-16

## Context

Every order stores a buyer snapshot (`orders.buyer`: document, name, email, phone, province and city) and its consents (`terms`, `privacy`, `marketing_email`, each with version and time, FR-COM-06). Amendment, 2026-10-28: orders that give chances also record `winner_publicity`, the optional consent to publish the buyer's name, city and chances if a coupon of that order wins (S5). It is the only buyer data a public endpoint returns, and only for consenting winners once results are published (SECURITY.md). The consent is revocable (Ley 25.326): a refusal on a later purchase, or a withdrawal on request that an admin with `orders.pii` records from the order detail, withdraws every earlier consent of that person. The withdrawal is a `winner_publicity` refusal with no order (`source` `support`), audited without personal data; a later purchase that grants it again covers that purchase only (S9). Amendment, 2026-10-28: the same orders also record `adult_declaration`, the buyer's required declaration of being 18 or older (S11), under the terms version; the API refuses a purchase that gives chances without it and stores nothing for it. The specs asked for "a retention policy" and the organization settings carried a `retentionDays` value ("retention for buyer PII after the campaign is archived"), but nothing ever applied it.

The owner decided that buyer data is not deleted when a period ends: the history of what happened (orders, payments, entries, draws, awards, deliveries) must be preserved and fully audited. They also wanted the data to serve email marketing. Argentine law (Ley 25.326, art. 4) lets personal data be used only for the purpose it was collected for, so marketing cannot be the reason to keep it, and writing to buyers who did not opt in, even to ask for consent, is itself marketing.

This records the rules the platform follows. It is not legal advice: the organization's counsel validates it in phase 0 of compliance, together with the draw rules (PRD §10).

## Decision

- **No deletion.** The platform never deletes or anonymizes buyer data on a schedule. Orders, buyer snapshots, consents, entries, draw evidence and the audit log are kept for the life of the organization. The legal basis for keeping them is the record of the sale and the auditable evidence of the draw (DRAW-INTEGRITY), not marketing.
- **Restricted and audited access.** Buyer data stays behind RBAC and tenant RLS: lists show what an operator needs (province, masked email), and full personal data needs `orders.pii`. Sensitive access and changes are written to the append-only audit log (FR-OPS-05). Public endpoints never return buyer data.
- **Marketing only with opt-in.** Only buyers whose order carries a granted `marketing_email` consent may receive marketing email, and only on the channel they accepted. A buyer without that consent is not contacted to ask for it. Transactional email (receipt, files, entries, award notices) is not marketing.
- **Suppression blocks, it does not destroy.** When a buyer exercises the right of suppression (Ley 25.326, art. 16) and the records must still be kept, the data is blocked: kept and audited, but excluded from any use other than the legal obligation and the draw evidence. Withdrawing marketing consent stops marketing at once. Building the blocking flow is future work; until then such requests are handled by the organization and recorded.
- **No retention setting.** `OrganizationSettings.retentionDays` is removed: it promised a deletion that will not happen. Values already stored in `organizations.settings` are left as they are and ignored, since rewriting stored data for a field nobody reads adds risk without benefit.

## Consequences

- The privacy policy each organization publishes must say that purchase and draw records are kept and why, and that marketing needs the opt-in. The platform cannot write it for them.
- Exports for marketing, when they exist, must filter by granted `marketing_email` consent and skip blocked buyers.
- A later blocking flow needs a per-buyer flag (or table), checks in exports and notifications, and audit events; it does not delete rows.
- Storage grows with every order; that is accepted.
