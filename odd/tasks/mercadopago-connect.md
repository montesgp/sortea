# Mercado Pago connect and disconnect (2026-10-17)

A platform admin connects an organization's Mercado Pago account in one step from the platform console and can disconnect it later (the owner will test with their own account, then unlink it).
Compliance approvals stay separate: they gate paid participations, not the shop's checkout.

## Specs

- S1 One-step connect: "La integration con mercado pago esta facil de conectar? Es decir voy a una interface como sysadmin sobre la organization, cargo los datos y salimos andando? Asi es como deberia ser mas alla de si existen o no certificados para aprobar." Saving credentials checks them with Mercado Pago first: refused credentials store nothing and say why; accepted ones are stored verified with the merchant account (collector id), and the organization can take payments.
- S2 Webhook guidance: the console shows the exact notification URL to paste in Mercado Pago and where the secret comes from, so nothing outside the console is needed to connect.
- S3 Disconnect: "Cuando este listo puedo usar y desvincular luego mi propia cuenta para testear". A platform admin disconnects the account after confirming; its sealed credentials are erased and the action is audited. While an order is awaiting payment the disconnect is refused with the reason, so no paid order is left unconfirmable. Afterwards the checkout says payments are not enabled.
- S4 Checkout requires a connected account whose merchant is known (verified), except the local simulator, so the merchant check of every payment is always on.

## Tasks

- T1 [S1, S2, S3, S4] inline; done; API connect/verify/disconnect + checkout guard + console UI; commit: the "Mercado Pago connects in one step" commit.
- T2 [S1-S4] gentle-ai-verify (risk item 2: credentials); done; S1-S4 met, one medium defect fixed (L4); same commit.

## Log

L1: "La integration con mercado pago esta facil de conectar? Es decir voy a una interface como sysadmin sobre la organization, cargo los datos y salimos andando? Asi es como deberia ser mas alla de si existen o no certificados para aprobar. Si no es asi empeceos a trabajar en eso. Cuando este listo puedo usar y desvincular luego mi propia cuenta para testear"
L2: Findings before work: save stored credentials as "configured" and a separate "Verificar conexión" filled the collector id; checkout accepted unverified integrations, so the merchant check was skipped (payments.ts:106 skips when expected is null); no webhook URL in the console; no disconnect; orders do not record the integration, so swapping or removing an account with orders awaiting payment would leave paid orders unconfirmable (webhooks use the active integration's secret). Decisions taken: disconnect deletes the integration rows (audit keeps the trail), refused while pending_payment orders have not expired (TTL 60 min).
L3: T1 inline. RED observed for 7 API cases (no webhookUrl, 200 instead of 400/409, 404 for DELETE, 201 instead of 503). Existing sealed-secrets test moved to a TEST- sandbox token because saving now checks the token with the provider (the test simulator accepts TEST- only). GREEN: API 158/158; E2E console flow (create org, refused token, connect, webhook URL, disconnect) passes.
L4: T2 gentle-ai-verify task mvcz78dw-1-ipxm: S1-S4 met. Medium defect: a checkout overlapping a disconnect read the integration before waiting on the organization row (FK lock at insert) and created an order with erased credentials; reproduced (201 instead of 503), fixed with organizations FOR SHARE at the start of the checkout transaction. Advisories fixed: payments pending/in_process also block switch/disconnect (late approvals after order expiry); only 400/401/403 mean rejected credentials, 429/5xx/no answer -> 502 with a log line without secrets. Tests added: 502 cases, tenant admin PUT 403, audit without secrets, crediting payment, overlap. API 166/166.
L5: E2E connect + purchase + admin + buyer-location 12/12. Committed and pushed together (owner: everything goes to the repo).
