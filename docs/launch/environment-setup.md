# Environment setup checklist

Pending steps for when the deployed environment is set up, probably on Railway (README, "Deploy (Railway + Supabase)"). The code for each item is done; only the account and configuration work remains.

## Email (Resend)

- [ ] In Resend, add the sender domain (for example `sortea.com.ar`). Create the DKIM, SPF and return-path records it lists in DNS, then wait until Resend shows the domain as verified.
- [ ] Create a Resend API key with sending access only, and keep it in the password manager.
- [ ] On the Railway `worker` service, set `EMAIL_PROVIDER=resend`, `RESEND_API_KEY` and `EMAIL_FROM_DOMAIN` (the verified domain).
- [ ] Request a lookup code from `/consulta` and confirm it arrives from `"<Organization>" <no-reply@EMAIL_FROM_DOMAIN>`.

Details: README, "Email (Resend)".

## Payments (Mercado Pago)

- [ ] Get MotoGarage's Mercado Pago credentials: first the test ones (`TEST-` access token), then production (`APP_USR-`). Create the webhook secret in Mercado Pago's notifications settings.
- [ ] In the platform console (`/admin/plataforma/<organization>`), load the access token, the webhook secret and the public key in sandbox mode, then press "Verificar" to confirm the account. Secrets are sealed and never shown again.
- [ ] On the Railway `api` service, set `API_PUBLIC_URL` to its public origin and expose only `/webhooks/*` publicly. Mercado Pago notifies `<API_PUBLIC_URL>/webhooks/mercadopago/<organizationId>`.
- [ ] Set `PAYMENTS_FAKE_PROVIDER=false` on every deployed service. The configuration refuses the simulator in production.
- [ ] Buy with a sandbox test card and confirm the order turns paid, the chances get numbers and the confirmation email arrives. Then switch the integration to production mode with the `APP_USR-` credentials.

Paid participations also need the campaign's compliance approvals (legal and Mercado Pago). People approve them with real documents; the system never marks them approved on its own (AGENTS.md, AC-12).
