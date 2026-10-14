# Design system — Premium motorsport commerce
## Intención
Inspiración motorsport premium y ecommerce de alta conversión; NO copiar estética casino ni usar dark patterns. Jerarquía clara: premio real, información legal, producto, checkout, transparencia. Fotografía auténtica. Interfaz mobile-first.
## Tokens base (personalizables por tenant)
`--bg: #090B10`, `--surface: #151923`, `--surface-2: #1D2330`, `--text: #F5F7FB`, `--muted: #AAB4C5`, `--accent: #F04438` (MotoGarage provisional), `--success: #25C89A`, `--warning: #F0B449`, `--radius: 16px`; tipografía grotesk legible; escala 4/8 px. Light theme obligatorio y pruebas de contraste.
## Layouts
- Institucional: navegación de marca y catálogo.
- Campaign shell: navegación simplificada, hero media, fecha, premios, CTA, catálogo y bloque de transparencia.
- Checkout: selección producto→upsell explícito→datos→pago→confirmación→consulta.
- Admin: sidebar, filtros, tablas virtualizadas, KPI cards, live activity, conciliación, gestión de premios.
## Componentes
`CampaignHero`, `PrizeCard`, `Countdown`, `OfferCard`, `CartDrawer`, `UpsellItem`, `GuestCheckout`, `PaymentStatus`, `EntryLookup`, `TransparencyTimeline`, `WinnerCard`, `EvidenceGallery`, `LiveKPIs`, `RevenueChart`, `ReconciliationTable`, `ThemePreview`.
## UX safeguards
No urgencia artificial; no probabilidades falsas; no mostrar PII; indicar precios y extras; deshabilitar compra al cierre real; estados de pago claros; diseño de errores/reintentos; reduced motion; keyboard navigation.
## Assets
Los SVG son **wireframes conceptuales originales**, no fotografías ni imágenes de la moto real. Sustituir por imágenes/video licenciados y auténticos de MotoGarage. `reference-lgcars.png` es referencia externa aportada por usuario.
