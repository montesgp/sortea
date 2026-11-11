# Mercado Pago setup

Where each Mercado Pago value comes from and where it goes, to connect an organization so its cart charges through Mercado Pago.
Checkout already offers Mercado Pago Checkout Pro as its only payment method, through the Orders API (ADR 0018): each checkout creates a Mercado Pago order, the buyer is redirected to Mercado Pago and comes back, and Mercado Pago notifies the order's changes. No code change is needed; connecting an account is configuration.

The developer panel is https://www.mercadopago.com.ar/developers/panel/app ("Tus integraciones").

## What the console asks for

The platform console (`/admin/plataforma/<organization>`, "Mercado Pago" panel) asks for three values and shows one.

| Value | Where it comes from in Mercado Pago | Console field |
| --- | --- | --- |
| Access token | Tus integraciones → *the application* → **Credenciales de producción** | "Access token" |
| Webhook secret | Tus integraciones → *the application* → **Configuración de webhooks → Firma secreta**, at the foot of that page; the eye button reveals it. It is **not** the **Client Secret** under Credenciales | "Firma secreta del webhook" |
| Public key | Same screen as the access token | "Public key" (optional; Checkout Pro does not use it) |
| Notification URL | **We give it**: the console shows `<API_PUBLIC_URL>/webhooks/mercadopago/<organization id>` | Pasted into the application's Webhooks, with the event **Order (Mercado Pago)** |

Connecting calls Mercado Pago (`/users/me`) before anything is stored, then seals the token and the secret; they are never shown again. A refused token stores nothing. Production mode requires an `APP_USR-` token. A webhook secret that starts with `APP_USR-` or `TEST-` is an access token pasted in the wrong field and is refused.

Mercado Pago cannot check the webhook secret; the notifications do. A wrong secret (for example the Client Secret) makes every notification fail its signature, and payments then wait for reconciliation. After connecting, press **Simular notificación** in the application's Webhooks and check that account in our console: "Última notificación firmada con esta cuenta" must show **Firma válida**. A notification that no account's secret validates shows **Firma rechazada** once, under "Notificaciones de pago". **Firma rechazada** means the stored secret is not that application's Firma secreta; fix it with **Actualizar credenciales** (below).

### Webhook event

Every application connected to an organization notifies the **Order (Mercado Pago)** event. Where Mercado Pago offers it, also select **Contracargos** (chargebacks). Do not select **Pagos**: payment notifications are answered and ignored, and only order notifications change a purchase.

### Which application each environment uses

- **Staging** connects the **test applications**, with Entorno **Sandbox (pruebas)**. They charge test accounts only.
- **Production** connects the **production applications** of the real accounts, with Entorno **Producción**.

An organization can have more than one account connected over time, for example the organization's own account and a second account, and platform staff switch between them (ADR 0017, "Switching accounts during a campaign" below). Each of those accounts needs its own application set up as described here, in each environment.

## Before you start

1. The `api` service is deployed with `API_PUBLIC_URL` set to its public HTTPS origin, and only `/webhooks/*` is public. Mercado Pago cannot notify `localhost`; to try from a local machine, point `API_PUBLIC_URL` to a public tunnel to the API.
2. `PAYMENTS_FAKE_PROVIDER=false` on the services that should reach Mercado Pago. With it on, every token goes to the local simulator, and production refuses it.
3. The campaign's compliance approvals, including "Aprobación del medio de pago", are recorded by a person (ADR 0015). Without them paid participations stay closed (AC-12).

## Step 1: test with test accounts

Mercado Pago's current guidance is to test with test users rather than `TEST-` tokens.

1. Sign in to the developer panel with the organization's real account and create an application (online payments, **Checkout Pro**).
2. In that application, open **Cuentas de prueba** and create two Argentine test accounts: a **seller** and a **buyer**. One account cannot be both.
3. In a private window, sign in to Mercado Pago as the **test seller**. If it asks for a code, it is listed under *Cuentas de prueba*. Create an application in its panel.
4. In that application, open **Credenciales de producción** and copy the **access token** (`APP_USR-…`). It is a test credential even though the panel says production, because it belongs to a test account.
5. In the same application, open **Configuración de webhooks → URL de producción** (the mode of the credentials you copied): paste the notification URL from our console, select the event **Order (Mercado Pago)** (and **Contracargos** if offered), press **Guardar** and copy the **Firma secreta** it shows (not the Client Secret under Credenciales).
6. In our console choose Entorno **Sandbox (pruebas)**, paste the token and the secret in "Firma secreta del webhook", and press **Conectar cuenta**. The account shows as verified with its merchant id. Press **Simular notificación** in Mercado Pago's Webhooks and check that the account shows **Firma válida**.
7. In a private window, without signing in to any real Mercado Pago account, buy chances on the site and pay as a guest with a test card, entering a made-up test-style email such as `test_user_4821@testuser.com` (or sign in as a **test buyer** first) (Mercado Pago's "Tarjetas de prueba" page; cardholder name `APRO` approves). Check that the order turns paid, the chances get coupon numbers and the confirmation email arrives.

A test seller only accepts test parties. Paying while signed in to a real Mercado Pago account, or as a guest with an email that belongs to a real account, fails: Mercado Pago shows "Una de las partes con la que intentás hacer el pago es de prueba" or "algo anduvo mal", and the order stays unpaid. For the same reason, in Sandbox mode our checkout sends no buyer email (or other buyer data) to Mercado Pago on purpose: the buyer's real email would make Mercado Pago refuse the payment. In Producción mode the buyer's data is sent as usual.

Without webhooks (for example, from a local machine without a tunnel), the next reconciliation run lists the payment as missing and a person applies it from `/admin/conciliacion`.

### Rehearsing a demo campaign with a test account

Outside production, `COMPLIANCE_DEMO=true` lets a campaign marked as demo open and earn chances while its approvals are pending (ADR 0013). With real Mercado Pago it applies only while the active account is a **test account**: when connecting, reactivating or verifying, our console asks Mercado Pago (`/users/me`) and shows "Cuenta de prueba de Mercado Pago" when it reports the `test_user` tag. A production account never gets the waiver, and switching to one removes it at once. Approvals stay pending; the site shows the demonstration notice with "pagos de prueba de Mercado Pago". Production refuses `COMPLIANCE_DEMO`.

## Step 2: production

1. With the organization's real account, open its application's **Credenciales de producción**. The first time, Mercado Pago asks to activate them (industry, website, terms). Copy the `APP_USR-` access token.
2. In that application's **Configuración de webhooks → URL de producción**, set the same notification URL with the event **Order (Mercado Pago)** (and **Contracargos** if offered), press **Guardar** and copy the new **Firma secreta** (not the Client Secret under Credenciales).
3. In our console, under **Cuenta de respaldo**, choose Entorno **Producción**, paste both values and press **Conectar cuenta de respaldo**. Press **Simular notificación** in Mercado Pago and check that the backup shows **Firma válida**, then switch to it with **Usar como principal** and your authenticator code (next section). The test account becomes the backup; see the next section for what happens to its purchases.

## Switching accounts during a campaign

Platform staff can switch an organization to another Mercado Pago account at any time, including while a campaign is open and orders await payment (ADR 0017). Organization roles cannot.

An organization has a **Cuenta principal**, which charges new purchases, and can have one **Cuenta de respaldo**: connected and verified like the principal, but charging nothing until it is used. Switching makes the backup the principal and the former principal the backup, so going back is the same action. Every switch asks for the platform admin's current authenticator code; set up the app in **Mi cuenta** first (ADR 0017, amendment 2026-11-11).

1. In the **backup** account's application, open **Configuración de webhooks**. Paste the same notification URL the console shows, select the event **Order (Mercado Pago)** (and **Contracargos** if offered), press **Guardar** and copy the **Firma secreta**. Do this first, so the account's orders are notified from its first purchase. Every account an organization uses, principal, backup or previous, notifies the order event to that same URL.
2. In our console, under **Cuenta de respaldo**, choose the Entorno, paste its access token and secret, and press **Conectar cuenta de respaldo**. Mercado Pago checks the token first; the account shows as verified with its merchant id and does not charge.
3. Test it before switching: press **Verificar conexión** on the backup (it checks that account's credentials with Mercado Pago, whichever account charges), then **Simular notificación** in its application and check that the backup shows **Firma válida** under "Última notificación firmada con esta cuenta".
4. Press **Usar como principal** on the backup. The console says what will happen: new purchases go to the backup's merchant, purchases already started stay on their account, and the current principal becomes the backup. Type the code your authenticator app shows and press **Confirmar cambio**. A wrong or already used code changes nothing; 5 wrong codes in 15 minutes lock the confirmation (and the sign-in's second factor) for 15 minutes. Mercado Pago checks the backup's stored credentials before the switch; if it refuses them, nothing changes and the console says so.
5. Leave the former principal's webhook configured in Mercado Pago, and do not reset its secret. Its pending payments, refunds and chargebacks keep arriving through it, and we verify them with its kept credentials.

With a principal connected, the console does not connect another account as the principal: a new account is always connected as the backup and switched to with the code. Connecting another backup moves the current one to "Cuentas anteriores" (**Reemplazar por otra cuenta** on the backup). If a previous account's secret has to change, update it with **Actualizar credenciales** on that account under "Cuentas anteriores"; it stays retired.

To go back to a previous account, find it under "Cuentas anteriores" and press **Volver a usar esta cuenta**: like **Usar como principal**, it says what will happen and asks for your code. No credentials are typed: we check the account's stored credentials with Mercado Pago first, and they must still belong to the same merchant. If Mercado Pago refuses them, nothing changes and the console says so; update them with **Actualizar credenciales** or connect that account again as the backup. Otherwise it becomes the principal, the principal until then moves to "Cuentas anteriores", and the backup stays. Its webhook must still be configured in Mercado Pago, as step 5 asks.

What happens to purchases:

- Purchases started before the switch are charged, confirmed and reconciled with the account they were created with. A buyer already on Mercado Pago's page pays the previous account.
- Purchases started after the switch use the new account. A purchase that starts at the same moment as the switch ends on one account or the other, never on both. Going back to a previous account works the same way.
- Reconciliation also searches each previous account that has orders created in the last 180 days, so a refund or chargeback whose notification was lost is still found. A previous account whose orders are all older is no longer searched; its payments are re-read only when one of them changes in our records or has an open item. If Mercado Pago no longer accepts a previous account's credentials (for example, they were revoked), reconciliation shows the critical item **Cuenta anterior sin acceso**. Restore that account's access, or settle its payments by hand in Mercado Pago, until the item clears.

Connecting the same account again (same merchant, same Entorno) renews that account, the principal or the backup; it does not add a previous one.

## Updating credentials

Each account, the principal, the backup and each previous one, has **Actualizar credenciales**: fill the new access token, the new "Firma secreta del webhook" or both, and press **Guardar credenciales**. A field left empty keeps its stored value. Nothing is switched: the account keeps its role, with its orders.

- A new access token is checked with Mercado Pago first and must belong to the same account (merchant). A token of another account is refused; to charge with another account, connect it as the backup and use **Usar como principal**. The check also refreshes whether Mercado Pago reports a test account.
- A new webhook secret is stored sealed without calling Mercado Pago. Confirm it with **Simular notificación** and "Última notificación firmada con esta cuenta" on that account.
- The audit records which fields changed (`integration.mercadopago.credentials_updated`), never their values.

## Care

- Never send credentials by chat or email. Paste them only in the console.
- A lost webhook secret is reset with **Redefinir** in the application's Webhooks; then paste the new one in that account's **Actualizar credenciales**.
- **Desvincular cuenta** asks first what will happen and then for your authenticator code, like **Usar como principal**; a wrong code deletes nothing. It erases every account, the principal, the backup and the previous ones, with their credentials, and the site stops charging. It is refused while any of them has payments in progress: orders awaiting payment (they expire after one hour) or payments being credited.
- The Orders API does not report Mercado Pago's fee, the net amount or the release date of a payment, so we read them from the order's payment in Mercado Pago's Payments API with the same credentials (ADR 0018). Finance shows the fees, the estimated net and the release date of each payment; a payment shows them as unknown ("sin dato de comisión") only while that read fails, and the next notification or reconciliation re-read fills them. The credited money still comes from the settlement report.
- We do not restrict payment types inside Checkout Pro. Cash methods (Rapipago, Pago Fácil) may credit after the order's one-hour expiry; reconciliation lists those payments for a person to resolve, even when every notification was lost, if they are approved within 7 days of the purchase: such an order is re-read in turns with the other unpaid orders of the last 7 days, so the approval is found once its turn comes up, usually within a few hours at current volumes (ADR 0018). A later approval is found only when its notification arrives.
