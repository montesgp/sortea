# ADR 0018: Checkout Pro through the Mercado Pago Orders API

Status: proposed, 2026-11-03. Becomes accepted once the spike (odd/tasks/mercadopago-orders-api.md, T2) confirms the open points below. Amends ADR 0002 (payment confirmation) and ADR 0006 (reconciliation); keeps ADR 0017 (account history).

## Context

Checkout uses Checkout Pro through the Preferences API: `POST /checkout/preferences`, then payment webhooks read with `GET /v1/payments/{id}`, and reconciliation with `GET /v1/payments/search`.

Mercado Pago's Checkout Pro reference now lists two paths: "Via Orders API (Recommended)" and "Via Preferences API (Legacy)". It says: "The Preferences API will continue to be supported, but new features will only be available in the Orders API. If you are starting a new integration, use the Orders API." No end-of-support date has been announced.

The platform has no real sales yet. Migrating now avoids migrating later with payments in flight. Owner decision: "Sí, migrar antes de producción".

## Decision

- Checkout creates a Checkout Pro order (`POST /v1/orders`, `type: online`, `processing_mode: manual`) with the order's account and redirects the buyer to its `checkout_url`. The request keeps today's rules: items and total, payer with identification, the order reference as `external_reference`, return URLs with auto return on approval, the one-hour expiry (as a duration), the statement descriptor and an idempotency key.
- Webhooks: the application's "Order (Mercado Pago)" event (and chargebacks) is enabled in the Mercado Pago panel, with the same notification URL per organization. The signature check is unchanged, with the order id lowercased in the manifest as Mercado Pago requires. The order is read with the account whose signature validates (ADR 0017), and its payments decide the platform order's state.
- The merchant check compares the order's seller (`user_id`) with the account's merchant id.
- Reconciliation reads orders instead of payments. Details depend on the spike: the Orders search filters by creation date only.
- The local simulator emulates orders instead of preferences.

## Open points (spike)

1. Whether a webhook URL can be set per order or only in the panel.
2. Whether `GET /v1/payments/{id}` and `/v1/payments/search` still return payments made through an order.
3. Whether refunds made from the Mercado Pago dashboard notify the order.

## Consequences

- Operators enable the order event in each Mercado Pago application (setup guide and console).
- Payment ids change format (`PAY...` within an order, `ORD...` for the order). Stored payments keep their provider ids; the change applies to new purchases only.
- The Preferences code path is removed once the Orders path is verified, since no production payments depend on it.
