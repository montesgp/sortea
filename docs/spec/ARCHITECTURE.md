# Arquitectura técnica
## Principios
Monolito modular API + worker, sin microservicios; dominio desacoplado de marca y PSP; integridad antes que velocidad aparente; eventos por outbox.
```mermaid
flowchart TD
  U[Visitante / comprador] --> W[SvelteKit SSR - Railway]
  A[Admin / SysAdmin] --> W
  W --> API[Fastify API - Railway]
  API --> DB[(Supabase PostgreSQL)]
  API --> MP[Mercado Pago tenant-specific]
  MP -->|Webhook| API
  API --> OUT[Outbox events]
  OUT --> WK[Worker - Railway]
  WK --> DB
  WK --> EMAIL[Resend]
  WK --> MP
  DB --> RT[Realtime Broadcast privado]
  RT --> W
```
### API modules
`iam`, `organizations`, `integrations`, `themes`, `cms`, `catalog`, `checkout`, `payments`, `reconciliation`, `campaigns`, `prizes`, `participations`, `draw-integrity`, `notifications`, `audit`, `reporting`.
### Boundaries
SvelteKit solo BFF/SSR/UI; Fastify fuente única de reglas de negocio. API privada a través de URL interna cuando sea posible; webhooks expuestos con autenticación del proveedor. Admin Auth Supabase con MFA y validación server-side; comprador guest.
### Transaction patterns
- Webhook no confía en payload como fuente de verdad; verifica autenticidad y consulta al PSP.
- DB transaction para estado de pago + entradas + outbox; índices únicos, locks o aislamiento apropiado.
- Worker procesa outbox con reintentos y deduplicación.
- Email: una cuenta Resend de plataforma envía los mails de todas las organizaciones, con el nombre de cada una como remitente visible y un dominio verificado (`EMAIL_FROM_DOMAIN`). Cada envío lleva `Idempotency-Key` por evento de outbox, así un reintento no duplica el mail; un rechazo permanente de Resend (4xx salvo 409/429) va directo a dead letter. Las cuentas Resend por organización de FR-ORG-02 quedan diferidas.
- Realtime envía eventos autorizados, nunca secretos ni PII; UI recarga snapshots.
- Tracking links (ADR 0019): each video or post gets a link `/?src=<code>`. The web remembers the visit in the first-party cookie `sortea_src` until the campaign closes and forwards the touches with the checkout; the API validates them and stores, inside the order transaction, every valid link plus the last one (`order_attributions`), or the network guessed from the referrer (`orders.source_channel`). Reports count paid purchases only, per link (participó and último), network and campaign, computed in memory in `packages/domain`.
### Deployment
Railway project: `web`, `api`, `worker`, ambientes preview/staging/production según costo. Supabase project administrado independiente; backups, PITR según plan y RPO/RTO documentados. CI: lint, typecheck, unit, integration, e2e, migration check, security scan, deploy.
