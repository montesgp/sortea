# Mercado Pago account switch during a campaign (2026-10-29)

Platform staff can switch an organization's Mercado Pago account at any time, including while a campaign is open. Each purchase is charged to, confirmed against and reconciled with the account that was active when it was created.
Work happens on branch feat/mercadopago-account-switch. High risk: payments, credentials, a migration and concurrency.

## Specs

- S1 Switch while selling: "necesitamos verificar y si no existe implementar un cambio de cuenta de mercado pago durante un proceso de campania. Es decir, mientras existe alguna campania abierta podemos querer cambiar la cuenta de mercado pago de destino desde el backoffice y todo deberia seguir funcionando correctamente." Switching the account is allowed while orders await payment or a campaign is open. It is no longer refused with payments_in_progress.
- S2 Purchase pinned to its account: "Si justo en el momento del cambio alguien compra, la compra se ejecuta contra la definida en ese momento, pero el proximo usuario ya pagaria a la cuenta que se acaba de cambiar." Each order records the account it was created with. The switch and the order creation are serialized, so an order is charged, confirmed (webhook, collector check), reconciled and refunded with its own account. The next order uses the new account.
- S3 Who can switch: "Eso solo pueden cambiarlo sysadmin por organizations." Only platform staff (platform admin), per organization. Organization roles cannot.
- S4 Previous account kept: decided by the parent (L2). The previous account's sealed credentials are kept as a retired account, so its in-flight payments and later refunds or chargebacks can still be verified. Only "Desvincular cuenta" deletes them, and that stays refused while any account has payments in progress.
- S5 Context: "En mi caso voy a cambiar de motogarage a otra cuenta en medio de la campania. Se supone que no deberia pisarme con ningun usuario porque esto no es nada de alto trafico, los usuarios van a entrar esporadicamente a comprar recursos. No es algo permanente y varios users." Low traffic, but correctness still must not depend on timing. The console and the setup guide explain the switch (configure the new account's webhooks with the same URL first, and keep the old one's).

## Tasks

- T1 [S1, S2, S4] worker; done; an account is a collector in a mode: the same pair updates its row (rotation), another pair creates one and retires the previous (retired_at, sealed credentials kept); migration 0016_account_history (partial unique active index, orders.payment_integration_id FK ON DELETE SET NULL, backfill for organizations with one account, legacy NULL accepted by the signing account's collector check); switch no longer refused, serialized by the organization lock; disconnect unchanged; commit 6344f02.
- T2 [S2] worker + parent; done; webhook tries the organization's accounts (active first) to find the signing one, reads the payment with it, refuses an order of another account (merchant_mismatch); reconciliation searches the active account and every retired account with orders updated in the window, merging by payment id; a retired account refused by Mercado Pago becomes the critical item account_unavailable (web label "Cuenta anterior sin acceso" added by the parent); suites db 54, domain 199, api 316, worker 14, web reconciliation 2; commit 6344f02.
- T3 [S1, S3, S4, S5] worker; done; console shows the active account and "Cuentas anteriores", the switch wording, Desvincular deletes every account; API disconnect messages generalized; setup guide section and ADR 0017 (amends ADR 0004); e2e switches an E2E organization only (motogarage and pista-sur accounts unchanged); commit 8a33dae.
- T4 [S1-S5] gentle-ai-verify; done; S1, S3, S4, S5 met; S2 partly: a lost refund/chargeback webhook of a retired-account order was never reconciled (accountsWithOrders used orders updated in the window); advisories: shared webhook secret, simulator signing with the active account, retired secret not updatable; suites domain 199, db 54, api 316, worker 14, web 181, e2e 9 passed; commit -.
- T5 [S2] worker; done; RETIRED_ACCOUNT_HORIZON_MS = 180 days on orders.created_at; webhook tries every validating account (the order's first) until one returns the payment; simulator signs with the order's account; 4 verifier tests + 3 new (RED 4 failed -> GREEN 17); api 323 passed; commit 2a07611.
- T6 [S1-S5] parent; pending; RDD assess, PR, merge on green check-and-test; commit -.

## Log

- L1 Original request (2026-10-29): "Ahora necesitamos verificar y si no existe implementar un cambio de cuenta de mercado pago durante un proceso de campania. Es decir, mientras existe alguna campania abierta podemos querer cambiar la cuenta de mercado pago de destino desde el backoffice y todo deberia seguir funcionando correctamente. Si justo en el momento del cambio alguien compra, la compra se ejecuta contra la definida en ese momento, pero el proximo usuario ya pagaria a la cuenta que se acaba de cambiar. Eso solo pueden cambiarlo sysadmin por organizations. En mi caso voy a cambiar de motogarage a otra cuenta en medio de la campania. Se supone que no deberia pisarme con ningun usuario porque esto no es nada de alto trafico, los usuarios van a entrar esporadicamente a comprar recursos. No es algo permanente y varios users."
- L2 Evidence (parent):
  - Switching is refused today with assertNoPaymentsInProgress when the collector id changes (apps/api/src/modules/platform.ts, PUT /platform/organizations/:id/integrations/mercadopago).
  - organization_integrations is unique per (organization, provider, mode) (packages/db/src/schema.ts:173), so switching in the same mode overwrites the previous credentials.
  - The webhook verifies the signature with the active account (apps/api/src/modules/webhooks.ts:36-40), fetches the payment with its token and expects its collector (confirm.ts expectedCollectorId).
  - Reconciliation searches only the active account (apps/api/src/modules/reconciliation.ts:231-234).
  - Orders do not record an account (schema orders); payments store collector_id.
  - Checkout reads the active account inside the order transaction (apps/api/src/modules/checkout.ts:87) and creates the preference after it with those credentials (:100). The organization row lock already orders checkout against the switch.
  - Decision: keep retired accounts until "Desvincular cuenta" (S4); the webhook URL per organization stays the same.
- L3 Decision (parent, 2026-10-29): retired accounts are searched by reconciliation while they have orders created in the last 180 days (chargeback horizon chosen by the platform, not guaranteed by Mercado Pago); pending owner confirmation.
