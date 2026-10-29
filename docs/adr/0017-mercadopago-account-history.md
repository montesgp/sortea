# ADR 0017: Mercado Pago account history and switching while selling

Status: accepted, 2026-10-29. Amends the 2026-10-17 amendment of ADR 0004 (Tenant secrets): switching to another merchant is no longer refused while payments are in progress.

## Context

ADR 0004's 2026-10-17 amendment kept one Mercado Pago account per organization. Orders did not record which account they were created with, and webhooks and reconciliation used the active account's credentials. So switching to another merchant was refused while any order awaited payment or any payment was being credited.

The owner needs to switch during an open campaign (odd/tasks/mercadopago-account-switch.md):

- S1: "mientras existe alguna campania abierta podemos querer cambiar la cuenta de mercado pago de destino desde el backoffice y todo deberia seguir funcionando correctamente."
- S2: "Si justo en el momento del cambio alguien compra, la compra se ejecuta contra la definida en ese momento, pero el proximo usuario ya pagaria a la cuenta que se acaba de cambiar."
- S3: "Eso solo pueden cambiarlo sysadmin por organizations."
- S5: "En mi caso voy a cambiar de motogarage a otra cuenta en medio de la campania." Traffic is low, but correctness must not depend on timing.

## Decision

- **An account is a merchant (collector id) in a mode.** Saving credentials for the same pair again is a rotation and updates that account. Any other pair creates a new account.
- **Retire, never overwrite.** Connecting another account marks the previous one retired (`retired_at`) and keeps its sealed credentials. One account per organization is active (a partial unique index). Only the active account takes new purchases.
- **Orders are pinned to their account.** Each order records the account it was created with (`orders.payment_integration_id`). Checkout takes the organization row `FOR SHARE` before reading the active account; connect and disconnect take it `FOR UPDATE`. A purchase that overlaps a switch therefore ends on the previous account, and the next one uses the new account. Migration 0016 assigns existing orders to the organization's account when it had exactly one; other legacy orders stay unassigned and are matched by the signing account's collector.
- **The webhook account comes from the signature.** A notification is checked against each of the organization's accounts, active first. The account whose secret validates it reads the payment, and the payment must belong to an order of that account (`merchant_mismatch` otherwise). Refunds and chargebacks arrive the same way, through the account that took the payment.
- **Reconciliation runs per account.** It searches the active account and every retired account with orders updated in the window, merging results by payment id. A retired account that Mercado Pago refuses becomes the critical item `account_unavailable` ("Cuenta anterior sin acceso"), which clears once the account answers again.
- **Disconnecting deletes every account.** "Desvincular cuenta" deletes the active and the retired accounts with their credentials. It is refused while any of them has payments in progress: orders awaiting payment, or payments `pending` or `in_process`. Orders keep their history; their account reference becomes empty.
- **Only platform staff switch accounts** (S3). The routes require a platform admin, and the console page is limited to them; organization roles get 403.

## Consequences

- A switch takes effect immediately, with no waiting window. The platform console explains that purchases already started are charged, confirmed and reconciled with the account they were created with.
- Each account's webhook must stay configured in Mercado Pago with the organization's notification URL, the previous account's included, until its payments, refunds and chargebacks are settled. The setup guide lists the steps (docs/launch/mercadopago-setup.md, "Switching accounts during a campaign").
- Retired credentials stay sealed in the database until the organization disconnects Mercado Pago. Revoking them in Mercado Pago shows up as `account_unavailable` in reconciliation instead of failing silently.
- Each webhook may try one signature check per account. That cost is negligible at the expected number of accounts per organization.
