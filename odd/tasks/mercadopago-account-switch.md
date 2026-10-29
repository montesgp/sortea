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

- T1 [S1, S2, S4] worker; pending; account history (one active account per organization, retired accounts kept), orders record their account (migration with backfill), switch allowed and serialized with checkout; commit -.
- T2 [S2] worker; pending; webhook identifies the account by signature, fetches the payment with it and requires it to match the order's account; reconciliation searches every account with orders in the period; commit -.
- T3 [S1, S3, S4, S5] worker; pending; platform console (active and previous accounts, switch wording), docs/launch/mercadopago-setup.md, ADR 0017; commit -.
- T4 [S1-S5] gentle-ai-verify; pending; commit -.

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
