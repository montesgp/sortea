# Mercado Pago Checkout Pro through the Orders API (2026-11-03)

Move the Checkout Pro integration from the Preferences API to the Orders API before production. Mercado Pago now labels Preferences "Legacy" and Orders "Recommended".
Work happens on branch feat/mercadopago-orders-api. High risk: payments, webhooks, reconciliation and account verification.

## Specs

- S1 Orders API for checkout: "me parece debemos cambiar el endpoint a api orders, porque actualmente el de preferencias esta por quedar deprecado". Decision (L2): "Sí, migrar antes de producción". Checkout creates a Checkout Pro order (POST /v1/orders, type online, processing_mode manual) and redirects the buyer to its checkout_url. It keeps every rule the preference had: items and total, payer with identification, the order reference as external_reference, return URLs with auto return on approval, the one-hour expiry, the statement descriptor and an idempotency key.
- S2 Confirmation from order webhooks: payments are confirmed, refunded and charged back from order notifications (topic order, signature with the panel secret; order ids lowercased in the manifest). The order and its payments are read with the order's own account (ADR 0017). An order of another seller never confirms.
- S3 Reconciliation still finds what a lost webhook missed: refunds, chargebacks and late approvals of orders created up to the reconciliation horizon (180 days for retired accounts), using what the Orders API offers.
- S4 Same guarantees as today: account pinning and the account switch (ADR 0017), the merchant check, idempotent confirmation, the pool and reservations (ADR 0014), refunds voiding coupons, the local simulator for development and e2e.
- S5 Setup and docs: the console and docs/launch/mercadopago-setup.md tell the operator to enable the "Order (Mercado Pago)" webhook event (and chargebacks) in the application. ADR 0018 records the decision.
- S6 Credentials stay out of chat: the owner's test credentials are used only from local configuration, never pasted into chat, logs or files in the repository.

## Tasks

- T1 [S1-S6] parent; pending; feature document, ADR 0018 (proposed until the spike); commit -.
- T2 [S1, S2, S3, S6] parent + owner; pending; spike with the owner's test application: create an order, pay it as a test buyer, read it, check /v1/payments compatibility, search orders, notification behavior; record results in L4; commit -.
- T3 [S1, S4] worker; pending; provider: Orders adapter for checkout and payment reads, status mapping, merchant check, simulator emulating orders; commit -.
- T4 [S2, S4] worker; pending; webhook topic order, signature manifest, confirmation from order payments; commit -.
- T5 [S3] worker; pending; reconciliation on the Orders API; commit -.
- T6 [S5] worker; pending; console, setup guide, environment checklist, ADR 0018 accepted; commit -.
- T7 [S1-S6] gentle-ai-verify; pending; commit -.
- T8 parent; pending; native review, PR, merge on green check-and-test; commit -.

## Log

- L1 Original request (2026-11-03): "Ya hice la config de una app de prueba luego de eso y probar e integrar vamos a la productiva. Pero me parece debemos cambiar el endpoint a api orders, porque actualmente el de preferencias esta por quedar deprecado. Te adjunto imagen con los datos". The image showed the test application's credentials and test user data; the parent did not use or repeat them and advised regenerating them.
- L2 Evidence and decision (2026-11-03):
  - No deprecation date was found. The official Checkout Pro reference labels "Via Orders API (Recommended)" and "Via Preferences API (Legacy)": "The Preferences API will continue to be supported, but new features will only be available in the Orders API. If you are starting a new integration, use the Orders API." (mercadopago.com.ar/developers/en/reference/online-payments/checkout-pro-orders/overview).
  - Checkout Pro with Orders is available in Argentina.
  - Owner decision: "Sí, migrar antes de producción".
- L3 Known differences (docs, 2026-11-03):
  - return URLs in config.online (success_url, failure_url, pending_url, auto_return); expiry as an ISO 8601 duration (expiration_time); config.statement_descriptor; external_reference up to 64 characters of letters, digits, - and _.
  - Webhook: event "Order (Mercado Pago)" configured in the panel, type=order, data.id ORD...; no per-order notification URL documented (config.online.callback_url is ambiguous).
  - Payments in transactions.payments[] (ids PAY..., status created/processing/processed/failed/refunded/charged_back/canceled/expired with status_detail); the seller is the order's user_id (no collector_id); refunds POST /v1/orders/{id}/refund; chargebacks need the extra event.
  - Search GET /v1/orders by creation date (begin_date/end_date, max 50 per page), no last-updated filter.
  - Unconfirmed: per-order webhook URL; whether GET /v1/payments/{id} works for payments made through an order; whether refunds made in the Mercado Pago dashboard notify the order.
