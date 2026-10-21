# Environment setup checklist

Pending steps for when the deployed environment is set up, probably on Railway (README, "Deploy (Railway + Supabase)"). The code for each item is done; only the account and configuration work remains.

## Web service

- [ ] On the Railway `web` service, set `ADDRESS_HEADER=X-Forwarded-For` and `XFF_DEPTH=1`, so the panel's sign-in throttle and the API rate limit see each visitor's address instead of the proxy's (docs/spec/SECURITY.md, "Acceso al panel").
- [ ] Put the panel behind Cloudflare Access (an `admin.` hostname with an email check before the login page; free up to 50 users), so bots never reach `/admin/login`.
- [ ] Enable a CAPTCHA on Supabase Auth (Cloudflare Turnstile keys in the Supabase project and on the login form) as the next layer against distributed guessing (docs/spec/SECURITY.md, "Acceso al panel").

## Reference data

- [ ] After `pnpm db:migrate`, run `pnpm db:geo` once against the deployed database to load countries, provinces and cities from GeoNames (CC BY 4.0, about 20 seconds). Without it the checkout only offers Argentina and accepts typed places (ADR 0012).

## Email (Resend)

- [ ] In Resend, add the sender domain (for example `sortea.com.ar`). Create the DKIM, SPF and return-path records it lists in DNS, then wait until Resend shows the domain as verified.
- [ ] Create a Resend API key with sending access only, and keep it in the password manager.
- [ ] On the Railway `worker` service, set `EMAIL_PROVIDER=resend`, `RESEND_API_KEY` and `EMAIL_FROM_DOMAIN` (the verified domain).
- [ ] Request a lookup code from `/consulta` and confirm it arrives from `"<Organization>" <no-reply@EMAIL_FROM_DOMAIN>`.

Details: README, "Email (Resend)".

## Payments (Mercado Pago)

- [ ] On the Railway `api` service, set `API_PUBLIC_URL` to its public origin and expose only `/webhooks/*` publicly.
- [ ] Get MotoGarage's Mercado Pago credentials: first the test ones (`TEST-` access token), then production (`APP_USR-`).
- [ ] In the platform console (`/admin/plataforma/<organization>`), copy the notification URL it shows into the Mercado Pago application's Webhooks (event: Payments), and copy the secret Mercado Pago shows there.
- [ ] In the same console, choose the mode, paste the access token and that secret, and press "Conectar cuenta". Mercado Pago checks them before they are stored; the account shows as verified with its merchant id. To stop using an account, "Desvincular cuenta" erases the credentials (refused while an order awaits payment).
- [ ] Set `PAYMENTS_FAKE_PROVIDER=false` on every deployed service. The configuration refuses the simulator in production.
- [ ] Do not set `COMPLIANCE_DEMO` on any deployed service. It is a local rehearsal mode (ADR 0013), and the configuration refuses it in production.
- [ ] Buy with a sandbox test card and confirm the order turns paid, the chances get numbers and the confirmation email arrives. Then switch the integration to production mode with the `APP_USR-` credentials.

To try a real account from a local machine, set `PAYMENTS_FAKE_PROVIDER=false` (with it on, every token goes to the simulator) and point `API_PUBLIC_URL` to a public tunnel to the API, since Mercado Pago cannot reach `localhost`. Without webhooks, the next reconciliation run lists the payment as missing and a person applies it from `/admin/conciliacion`.

Paid participations also need the campaign's compliance approvals (legal and Mercado Pago). People approve them with real documents; the system never marks them approved on its own (AGENTS.md, AC-12).
