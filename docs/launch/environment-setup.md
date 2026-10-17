# Environment setup checklist

Pending steps for when the deployed environment is set up, probably on Railway (README, "Deploy (Railway + Supabase)"). The code for each item is done; only the account and configuration work remains.

## Email (Resend)

- [ ] In Resend, add the sender domain (for example `sortea.com.ar`). Create the DKIM, SPF and return-path records it lists in DNS, then wait until Resend shows the domain as verified.
- [ ] Create a Resend API key with sending access only, and keep it in the password manager.
- [ ] On the Railway `worker` service, set `EMAIL_PROVIDER=resend`, `RESEND_API_KEY` and `EMAIL_FROM_DOMAIN` (the verified domain).
- [ ] Request a lookup code from `/consulta` and confirm it arrives from `"<Organization>" <no-reply@EMAIL_FROM_DOMAIN>`.

Details: README, "Email (Resend)".
