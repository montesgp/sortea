# ADR 0002: Orders are confirmed only by verified provider data, exactly once

Status: accepted, 2026-10-14

## Context

AC-01 and AC-03 require that an order is paid exactly once even with ten duplicate webhooks, and never because of a browser redirect.

## Decision

1. The checkout creates a `pending_payment` order with a server-side price snapshot; the browser only sends variant ids and quantities.
2. The Mercado Pago webhook is authenticated with the organization's secret (HMAC-SHA256 over `id;request-id;ts`, timing-safe comparison).
3. The payload is never trusted. The API re-reads the payment with that organization's access token and checks reference, amount, currency and merchant (collector id).
4. One transaction applies the result: order row locked `FOR UPDATE`, payment upserted on `(organization_id, provider, provider_payment_id)`, state machine in `@sortea/domain`, participations allocated through `entry_allocations` (unique per order), stock decremented, outbox event with a dedupe key.
5. Refunds and chargebacks move the order forward and void entries through the ledger; nothing is deleted.
6. The return page only shows the status held by the API.

For local development, `PAYMENTS_FAKE_PROVIDER=true` swaps the provider for an in-memory simulator that signs its notifications with the tenant's secret, so everything after "payment" runs the production code path. Configuration refuses the simulator in production.

## Consequences

- Mismatched payments are recorded and audited but never applied; an operator resolves them.
- Reconciliation (next phase) can rely on `payments` and `payment_events` as the system's own ledger to compare with provider reports.
