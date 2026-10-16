# PRD — Multi-tenant Campaign Commerce Platform
**Estado:** Ready for agent planning · **Fecha:** 2026-10-14 · **Producto:** TBD · **Primer tenant:** MotoGarage · **Idioma:** es-AR

## 1. Visión y problema
Construir una plataforma B2B multi-tenant, white-label, para comercio digital, campañas promocionales, registro verificable de participaciones, premios múltiples, pagos, conciliación, operaciones en tiempo real y publicación de evidencias. MotoGarage es el primer tenant; evitar código específico de marca en el dominio. No confundir plataforma de comercio/promociones con un servicio de apuestas. **No habilitar participaciones pagas ni adjudicaciones hasta aprobación legal y del PSP para la modalidad concreta.**

## 2. Objetivos
- Publicar landing pública de MotoGarage, catálogo y micrositio de campañas con layouts independientes.
- Comprar productos digitales/físicos sin crear cuenta; obtener confirmación y acceso seguro al material.
- Registrar identidad, consentimiento y comprobantes, sin exponer DNI en consultas públicas.
- Operar campañas con uno o varios premios, ganadores, suplentes, entregas y documentación.
- Administrar y conciliar pagos Mercado Pago por organización, sin mezcla de fondos.
- Proporcionar tablero operativo casi en tiempo real, reportes y auditoría reproducible.
- Reutilizar la misma plataforma en nuevas organizaciones con tema, dominio, contenidos y credenciales propios.

## 3. No objetivos MVP
- Constructor visual drag-and-drop; marketplace de extensiones; múltiples PSP en producción; WhatsApp saliente; facturación SaaS; motor logístico avanzado; automatizaciones de marketing; app móvil nativa; mecanismo de selección no autorizado; métricas de probabilidad no fundamentadas.

## 4. Personas y RBAC
- `platform_superadmin`: administra organizaciones, habilita módulos, integraciones, dominios, políticas y auditoría global; acceso privilegiado con MFA.
- `org_owner`: configura miembros, campañas, contenido y consulta finanzas de su organización; no puede ver secretos en texto plano.
- `org_admin`: campañas, productos, premios, contenidos, participantes, reportes.
- `finance_manager`: pagos, conciliación, reportes y anomalías; no puede alterar asignaciones.
- `campaign_operator`: operaciones de campaña, evidencias, entregas y atención.
- `auditor`: lectura de evidencias, reglas, cierres, conciliaciones y logs.
- `support_agent`: acceso mínimo a datos de atención, con enmascaramiento.
- `buyer`: **sin login**; consulta puntual con DNI + OTP/código de comprobante.
RBAC evaluado en API, con autorización por recurso y organización; los permisos nunca se derivan únicamente de menús ocultos.

## 5. Requisitos funcionales (IDs estables)
### FR-ORG — Organizaciones y configuración
- FR-ORG-01 SysAdmin crea/suspende organizaciones y define slug, branding, idioma, zona horaria, moneda y módulos.
- FR-ORG-02 Cada organización tiene configuración aislada de Mercado Pago, Resend, Storage, dominio y tema; credenciales cifradas, versionadas, rotables, jamás expuestas al cliente.
- FR-ORG-03 Credenciales MP por tenant con modo sandbox/producción, verificación de conectividad y auditoría; configurar desde SysAdmin; soporte para futura conexión OAuth si aplica.
- FR-ORG-04 Aislamiento lógico por `organization_id` en todas las entidades de negocio; RLS y filtros explícitos; índices compuestos por tenant.
- FR-ORG-05 Tema multi-theme: design tokens (colores, tipografía, bordes, sombras, espaciados, densidad, iconografía), dark/light, overrides por organización y opcionalmente campaña; contraste WCAG AA y fallback seguro.
- FR-ORG-06 Dominios personalizados y mapeo hostname→tenant con validación, sin permitir spoofing de tenant desde el cliente.
### FR-CMS — Sitio público
- FR-CMS-01 Home MotoGarage configurable; catálogo, campañas activas/pasadas, FAQ, legales, contacto y redes.
- FR-CMS-02 `/sorteos`, `/sorteos/[slug]`, `/sorteos/[slug]/transparencia`, `/consulta`, `/tienda`; navegación contextual distinta de home corporativa.
- FR-CMS-03 Hero con fotografía/video auténtico, countdown basado en servidor, CTA, estado, premios, fecha, requisitos y reglas.
- FR-CMS-04 CMS para imágenes, video URLs, banners, copy, SEO/OpenGraph, FAQs, legales, ganadores y evidencias de entrega.
- FR-CMS-05 Incrustar transmisión en vivo y replay de YouTube; publicar acta y evidencias sin afirmar verificación externa inexistente.
### FR-COM — Comercio
- FR-COM-01 Productos digitales (manual PDF, bundles) y físicos (calcomanías); variantes, precio, impuestos, moneda, stock opcional, vigencia y recursos.
- FR-COM-02 Carrito con upsells transparentes y opt-in explícito, sin casillas preseleccionadas; total recalculado en backend.
- FR-COM-03 Checkout guest: DNI/tipo, nombre, apellido, email, teléfono opcional/según entrega, provincia (una de las 24 jurisdicciones) y ciudad en toda compra (el envío va a esa ciudad y provincia), datos fiscales/logísticos cuando apliquen; validación; los datos se conservan sin borrado (ADR 0010). Provincia y ciudad son datos personales: se guardan en el snapshot del comprador de la orden, los listados del panel muestran solo la provincia y la ciudad requiere permiso de PII.
- FR-COM-04 Crear orden pendiente, snapshot de precios y reglas; no confiar en importe del navegador.
- FR-COM-05 Entregar PDF con URL firmada y vencimiento, recibo y comprobante; reenvío controlado y rate limit.
- FR-COM-06 Consentimientos separados para transacción, privacidad y marketing (opt-in por canal); registrar versión y timestamp.
### FR-PAY — Pagos
- FR-PAY-01 Integrar Mercado Pago por tenant, Checkout Pro en MVP sujeto a aprobación; `external_reference` interna única.
- FR-PAY-02 Webhook autenticado + consulta server-to-server de pago, importe, moneda, merchant, estado y referencia.
- FR-PAY-03 Idempotencia por proveedor/payment ID, transición de estados y transacción atómica de confirmación y participaciones.
- FR-PAY-04 Gestionar pendientes, rechazados, reembolsos, chargebacks, errores y reintentos; definir impacto en elegibilidad según reglas publicadas.
- FR-PAY-05 Conciliación programada por operaciones, más conciliación de liquidaciones/saldos cuando API/reportes lo permitan; exportar CSV de sistema y PSP; mostrar diferencias, evidencia y resolución humana sin inventar aprobaciones.
- FR-PAY-06 Distinguir bruto, comisiones, reintegros, neto estimado, acreditado, disponible y salidas; no inferir saldo disponible de ventas aprobadas.
### FR-CAMP — Campañas y premios
- FR-CAMP-01 Crear borrador, revisión, publicación, apertura, cierre, adjudicación, entrega y archivo; transiciones validadas por API.
- FR-CAMP-02 Fechas y horas con zona horaria, inicio/cierre, streaming, modalidad, autoridad/organismo aplicable, bases legales versionadas y reglas de elegibilidad.
- FR-CAMP-03 Configurar múltiples premios por campaña: vehículo, dinero, producto, digital; valor declarado, cantidad, orden, ganadores/suplentes, condiciones y evidencia.
- FR-CAMP-04 Separar `prizes`, `prize_awards`, `prize_fulfillments`; registrar aceptación, rechazo, sustitución permitida y entrega.
- FR-CAMP-05 Configurar ofertas/bundles y reglas de participación **solo para modalidades autorizadas**; no presuponer que comprar más genera más chances.
- FR-CAMP-06 Bloquear reglas esenciales al abrir campaña; cambios materiales requieren nueva versión, aprobación y comunicación.
### FR-ENTRY — Participaciones y transparencia
- FR-ENTRY-01 Identidad única por organización/tipo de documento/documento normalizado, con UUID interno; no usar DNI como PK.
- FR-ENTRY-02 Ledger append-only de participaciones, estado de elegibilidad y origen; restricciones de unicidad y concurrencia.
- FR-ENTRY-03 Consulta de DNI requiere OTP a contacto verificado o código de acceso robusto; no revelar existencia de DNI ni PII a terceros; rate limiting y anti-enumeración.
- FR-ENTRY-04 Mostrar comprobante, identificadores, cantidad y estado propios; probabilidades solo si el método autorizado permite cálculo exacto y con denominador correcto; advertir variación hasta cierre.
- FR-ENTRY-05 Portal público con totales agregados, reglas, cierre, hash SHA-256 del registro canónico, procedimiento, acta, transmisión, adjudicaciones y entregas con privacidad.
- FR-ENTRY-06 Mecanismo de selección parametrizable únicamente tras definición legal; si usa lotería oficial, registrar fuente oficial, extracción y algoritmo reproducible; si escribano, registrar acta y datos de intervención.
### FR-OPS — Operaciones y administración
- FR-OPS-01 Dashboard privado por tenant con ventas, participantes, entradas, pagos, premios comprometidos, premios pagados, neto proyectado y alertas.
- FR-OPS-02 Actualización casi en tiempo real mediante Broadcast privado + snapshot/resync, sin prometer latencia fija de un segundo.
- FR-OPS-03 Lista de movimientos, filtros, exportaciones y reconciliación con autorización; PII minimizada y acciones auditadas.
- FR-OPS-04 Gestión de campañas, contenidos, premios, ganadores, links de video, fotos de entrega, legales, usuarios y roles.
- FR-OPS-05 Registro de auditoría de accesos sensibles, cambios de configuración, integraciones, reglas, conciliación y premios; retención y protección ante alteraciones.
### FR-NOTIF — Mensajería
- FR-NOTIF-01 Email transaccional de compra, disponibilidad, comprobante y consulta OTP mediante cola durable.
- FR-NOTIF-02 Abstracción `NotificationProvider` con plantillas, idioma, preferencias, consentimientos, intentos y estados.
- FR-NOTIF-03 **Futuro:** WhatsApp Business oficial, templates aprobados, recordatorios de fecha, enlace a vivo, anuncios de resultados, unsubscribe y costos.

## 6. Flujos críticos
**Compra:** carrito→API recalcula→orden PENDING→preferencia MP por tenant→webhook→validación de firma y consulta MP→transacción de confirmación→participaciones según modalidad autorizada→outbox→email→consulta privada.
**Conciliación:** job periódico→listar/consultar operaciones MP→match por payment ID, reference, importe, moneda y estado→anomalías→revisión humana→exportaciones y evidencia.
**Cierre:** bloquear nuevas participaciones→resolver pagos en tránsito según reglas→congelar lista elegible→generar manifest y hash→publicar compromiso→ejecutar mecanismo aprobado→guardar acta y resultados→verificar ganador→publicar resultado→registrar entrega.
**SysAdmin:** crear organización→configurar tema/dominio→asignar roles→cargar integración MP cifrada→probar sandbox→aprobar go-live→monitorear sin mezclar tenants.

## 7. Modelo de datos conceptual
`organizations`, `organization_domains`, `organization_themes`, `organization_integrations`, `organization_members`, `roles`, `role_permissions`, `campaigns`, `campaign_rule_versions`, `campaign_media`, `campaign_faqs`, `products`, `product_assets`, `offers`, `offer_items`, `contacts`, `contact_identifiers`, `contact_consents`, `orders`, `order_items`, `payments`, `payment_events`, `payment_settlements`, `reconciliation_runs`, `reconciliation_items`, `participation_entries`, `entry_allocations`, `entry_ledger_events`, `draw_events`, `draw_manifests`, `prizes`, `prize_awards`, `prize_fulfillments`, `notifications`, `notification_attempts`, `audit_events`, `outbox_events`.
Invariantes: dinero en enteros de unidad menor (centavos); timestamps UTC + zona horaria de presentación; claves UUID; FKs; restricciones únicas `(organization_id, provider, provider_payment_id)`; un webhook repetido no duplica entradas; una participación nunca se asigna a otro tenant; reversión nunca borra el historial.

## 8. Requisitos no funcionales
- Seguridad: OWASP ASVS L2 como referencia; TLS, CSP, CSRF donde aplique, protección SSRF en media URLs, rate limits, secrets server-only, MFA admin, logs sin secretos/PII, backups y recuperación ensayada.
- Privacidad: Ley argentina 25.326 y normativa aplicable; finalidad, minimización, derechos ARCO (la supresión bloquea el registro en lugar de destruirlo), conservación sin borrado de compras y evidencia del sorteo (ADR 0010), marketing solo con opt-in, cifrado, controles de acceso; no exponer DNI en endpoints públicos.
- Performance (objetivos, validar con pruebas): LCP móvil p75 <2.5 s, INP p75 <200 ms, CLS <0.1, API p95 <300 ms para lecturas locales sin terceros, reconciliación eventual con métricas y alertas.
- Fiabilidad: idempotencia de pagos, outbox transaccional, workers reintentables, DLQ o estado dead-letter, migraciones reversibles donde sea posible, monitoreo Sentry y alertas.
- Accesibilidad: WCAG 2.2 AA objetivo; responsive 360px+, teclado, reduced motion, contraste, textos legibles.
- Realtime: eventos privados, snapshot inicial, secuencia/versionado y resync tras reconexión.
- SEO: SSR, metadatos, OG images, sitemap, canonical, schema.org donde aplique.

## 9. Criterios de aceptación end-to-end
- AC-01 Comprador completa checkout sin cuenta, MP confirma por API y la orden se marca pagada exactamente una vez incluso con 10 webhooks duplicados.
- AC-02 Dos tenants con datos, credenciales y roles distintos no pueden consultar, mutar ni suscribirse a datos ajenos.
- AC-03 Una orden no se confirma por retorno del navegador ni por captura de transferencia.
- AC-04 El dashboard recibe eventos y se resincroniza correctamente tras pérdida de conexión.
- AC-05 SysAdmin configura MP para una organización sin revelar tokens al browser ni a otros tenants.
- AC-06 Una campaña tiene 1 vehículo, 10 premios monetarios y 5 físicos; adjudicaciones, suplencias y entregas independientes.
- AC-07 DNI ajeno no permite consultar participaciones sin segundo factor; endpoints resisten enumeración.
- AC-08 Las reglas publicadas no se reescriben silenciosamente tras apertura.
- AC-09 Conciliación detecta pago ausente, monto diferente, refund y discrepancia de liquidación.
- AC-10 Tema de MotoGarage y tema de otro tenant cambian sin fork de frontend.
- AC-11 Se puede generar y volver a verificar el hash del manifest final de participaciones.
- AC-12 Una campaña no puede pasar a estado activo si faltan aprobaciones legales/PSP requeridas.

## 10. Roadmap y dependencias
**Fase 0 — Descubrimiento y compliance:** validar jurisdicción, modalidad, bases, autoridad, escribano/lotería y permiso MP; especificar tratamiento de datos y política de reintegros. *Bloquea activación de participaciones.*
**Fase 1 — Plataforma base:** monorepo, Supabase, tenant/RBAC, SysAdmin, temas, CMS y landing MotoGarage.
**Fase 2 — Commerce:** catálogo, carrito, guest checkout, MP sandbox, webhooks, ledger, email, archivos.
**Fase 3 — Operación:** dashboard realtime, conciliación, premios múltiples, administración de campañas y transparencia.
**Fase 4 — Lanzamiento:** pruebas de carga, pentest proporcional, DR, QA E2E, conciliación con casos reales, revisión legal, producción.
**Futuro:** WhatsApp, dominios white-label avanzados, CRM, marketing, APIs públicas, SaaS billing, más PSP.

## 11. Referencias visuales
- `../assets/references-local/reference-lgcars.png` (local only, not committed): captura aportada por el cliente, **solo referencia funcional**, no copiar diseño, contenido ni branding.
- `../assets/motogarage-concept.svg`: mockup vectorial de landing premium motorsport.
- `../assets/operations-concept.svg`: mockup vectorial de dashboard en tiempo real.
- `../assets/checkout-concept.svg`: mockup vectorial de compra con agregados.
- `DESIGN.md`: tokens, jerarquía y pautas de interfaz.

## 12. Decisiones cerradas / abiertas
**Cerradas:** Railway web+API+worker; Supabase Cloud como DB/Storage/Auth; SvelteKit SSR; Fastify; TypeScript; Drizzle; Mercado Pago por organización configurado por SysAdmin; checkout guest; email MVP; WhatsApp futuro; temas por tenant; RBAC; dashboard realtime; conciliación; premios múltiples; MotoGarage primer tenant.
**Abierta (marca):** nombre público y nombre final de repo. Usar `campaign-platform` como placeholder neutro.
**Dependencias regulatorias obligatorias (no decisiones de branding):** modalidad legal, permisos, reglas de asignación/selección, autoridad competente, tratamiento fiscal, aceptación PSP. No inventar estos datos.
