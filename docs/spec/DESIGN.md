# Design system — Premium motorsport commerce
## Intención
Inspiración motorsport premium y ecommerce de alta conversión; NO copiar estética casino ni usar dark patterns. Jerarquía clara: premio real, información legal, producto, checkout, transparencia. Fotografía auténtica. Interfaz mobile-first.
## Tokens base (personalizables por tenant)
`--bg: #090B10`, `--surface: #151923`, `--surface-2: #1D2330`, `--text: #F5F7FB`, `--muted: #AAB4C5`, `--accent: #F04438` (primer cliente, provisional), `--success: #25C89A`, `--warning: #F0B449`, `--radius: 16px`; tipografía grotesk legible; escala 4/8 px. Light theme obligatorio y pruebas de contraste.
## Layouts
- Institucional: navegación de marca y catálogo.
- Campaign shell: navegación simplificada, hero media, fecha, premios, CTA, catálogo y bloque de transparencia.
- Checkout: selección producto→upsell explícito→datos→pago→confirmación→consulta.
- Admin: sidebar, filtros, tablas virtualizadas, KPI cards, live activity, conciliación, gestión de premios. Todo lo del usuario está en el menú de usuario al pie del sidebar (alias o email, rol, estado del segundo factor): "Mi cuenta" (`/admin/cuenta`: contraseña, verificación en dos pasos, tema, cerrar sesión) y "Cerrar sesión"; la navegación principal tiene solo las secciones del panel. El tema del panel usa las mismas variantes del sitio (claro y oscuro de los tokens del tenant) y cada navegador elige "Claro" u "Oscuro" sin cambiar el sitio público (owner feedback 2026-11-10 S11; solo dos opciones desde console polish 2026-11-11 S2). Sin elección, el panel usa el modo por defecto del sitio.
## Componentes
`CampaignHero`, `PrizeCard`, `Countdown`, `OfferCard`, `CartDrawer`, `UpsellItem`, `GuestCheckout`, `PaymentStatus`, `EntryLookup`, `TransparencyTimeline`, `WinnerCard`, `EvidenceGallery`, `LiveKPIs`, `RevenueChart`, `ReconciliationTable`, `ThemePreview`.
## UX safeguards
No urgencia artificial; no probabilidades falsas; no mostrar PII; indicar precios y extras; deshabilitar compra al cierre real; estados de pago claros; diseño de errores/reintentos; reduced motion; keyboard navigation.
## Assets
Los SVG son **wireframes conceptuales originales**, no fotografías ni imágenes de la moto real. Sustituir por imágenes/video licenciados y auténticos de cada cliente. `reference-lgcars.png` es referencia externa aportada por usuario.
