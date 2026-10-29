# Mercado Pago setup

Where each Mercado Pago value comes from and where it goes, to connect an organization so its cart charges through Mercado Pago.
Checkout already offers Mercado Pago Checkout Pro as its only payment method: the buyer is redirected to Mercado Pago and comes back. No code change is needed; connecting an account is configuration.

The developer panel is https://www.mercadopago.com.ar/developers/panel/app ("Tus integraciones").

## What the console asks for

The platform console (`/admin/plataforma/<organization>`, "Mercado Pago" panel) asks for three values and shows one.

| Value | Where it comes from in Mercado Pago | Console field |
| --- | --- | --- |
| Access token | Tus integraciones → *the application* → **Credenciales de producción** | "Access token" |
| Webhook secret | Tus integraciones → *the application* → **Webhooks → Configurar notificaciones**, shown after saving | "Clave secreta de notificaciones" |
| Public key | Same screen as the access token | "Public key" (optional; Checkout Pro does not use it) |
| Notification URL | **We give it**: the console shows `<API_PUBLIC_URL>/webhooks/mercadopago/<organization id>` | Pasted into the application's Webhooks |

Connecting calls Mercado Pago (`/users/me`) before anything is stored, then seals the token and the secret; they are never shown again. A refused token stores nothing. Production mode requires an `APP_USR-` token.

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
5. In the same application, open **Webhooks → Configurar notificaciones → Modo productivo**: paste the notification URL from our console, select the **Pagos** event, press **Guardar** and copy the **secret** it shows.
6. In our console choose Entorno **Sandbox (pruebas)**, paste the token and the secret, and press **Conectar cuenta**. The account shows as verified with its merchant id.
7. In a private window signed in as the **test buyer**, buy chances with a test card (Mercado Pago's "Tarjetas de prueba" page; cardholder name `APRO` approves). Check that the order turns paid, the chances get coupon numbers and the confirmation email arrives.

Without webhooks (for example, from a local machine without a tunnel), the next reconciliation run lists the payment as missing and a person applies it from `/admin/conciliacion`.

## Step 2: production

1. With the organization's real account, open its application's **Credenciales de producción**. The first time, Mercado Pago asks to activate them (industry, website, terms). Copy the `APP_USR-` access token.
2. In that application's **Webhooks → Modo productivo**, set the same notification URL with the **Pagos** event and copy the new secret.
3. In our console use **Cambiar de cuenta**, choose Entorno **Producción**, paste both values and press **Conectar cuenta**. The test account moves to "Cuentas anteriores"; see the next section for what happens to its purchases.

## Switching accounts during a campaign

Platform staff can switch an organization to another Mercado Pago account at any time, including while a campaign is open and orders await payment (ADR 0017). Organization roles cannot.

1. In the **new** account's application, open **Webhooks → Configurar notificaciones**. Paste the same notification URL the console shows, select the **Pagos** event, press **Guardar** and copy the secret. Do this first, so the new account's payments are notified from the first purchase.
2. In our console, under **Cambiar de cuenta**, choose the Entorno, paste the new access token and secret, and press **Conectar cuenta**. The new account shows under "Cuenta activa" and the previous one under "Cuentas anteriores" with the date it was retired.
3. Leave the **previous** account's webhook configured in Mercado Pago. Its pending payments, refunds and chargebacks keep arriving through it, and we verify them with its kept credentials.

What happens to purchases:

- Purchases started before the switch are charged, confirmed and reconciled with the account they were created with. A buyer already on Mercado Pago's page pays the previous account.
- Purchases started after the switch use the new account. A purchase that starts at the same moment as the switch ends on one account or the other, never on both.
- Reconciliation also searches each previous account that has orders in the period. If Mercado Pago no longer accepts a previous account's credentials (for example, they were revoked), reconciliation shows the critical item **Cuenta anterior sin acceso**. Restore that account's access, or settle its payments by hand in Mercado Pago, until the item clears.

Saving new credentials of the same account (same merchant, same Entorno) renews the active account; it does not add a previous one.

## Care

- Never send credentials by chat or email. Paste them only in the console.
- A lost webhook secret is reset with **Redefinir** in the application's Webhooks; then connect again with the new secret.
- **Desvincular cuenta** erases every account, the active one and the previous ones, with their credentials, and the site stops charging. It is refused while any of them has payments in progress: orders awaiting payment (they expire after one hour) or payments being credited.
- We do not restrict payment types inside Checkout Pro. Cash methods (Rapipago, Pago Fácil) may credit after the order's one-hour expiry; reconciliation lists those payments for a person to resolve.
