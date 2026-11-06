# Back office polish (2026-11-06)

FAQ numbering and collapsing in the site editor, a wider orders search with a date range, the order detail layout, and a paginated, searchable audit log.
Work happens on branch feat/admin-polish-2026-11-06 (from main). The Mercado Pago Orders migration (feat/mercadopago-orders-api) is independent and waits for its paid-order test.

## Specs

- S1 FAQ numbering: "Mientras revisemos que dentro del backoffice http://localhost:5173/admin/sitio?tab=preguntas van 0,1,2,3 y como proxima nueva propuesta dice 5 y en realidad es la 4ta. Es un detalle pero corrijamoslo." Questions are numbered from 1, and the next new one shows the next number (after 1, 2, 3, 4 comes 5).
- S2 Collapsible FAQs: "Tambien dentro de ese tab de Preguntas frecuentes deberia poder minimizar/colapsar cada pregunta para reducir espacio vertical en pantalla. Por defecto que aparezcan colapsadas y solo datos basicos. Si se desea se expande." Each question is collapsed by default, showing only its number and question text (and its state if any), and expands to edit.
- S3 Orders search: "Dentro de http://localhost:5173/admin/pedidos el buscador por comprobante nommbre o email es demasiado chico y tiene el placeholder cortado. Quiza tambien estaria bien poder buscar por fecha de realizacion desde hasta." The search field is wide enough for its placeholder, and the list can be filtered by creation date from/to (in the organization's time zone), combinable with the text search and kept in the URL.
- S4 Order detail layout: "En el detalle del pedido se ve desbordada la segunda card o caja mira fijate como el Pago de MP se pierde" (screenshot: in the "Pagos de Mercado Pago" card a long payment id pushes the amount out of the card). No card overflows at desktop or mobile widths; long ids wrap or truncate with the full value available.
- S5 Audit log: "http://localhost:5173/admin/auditoria deberia ser paginado porque pueden existir muchos registros en un futuro. Y tener algun input de busqueda segun te parezca por criterio. Algo simple." The audit list is paginated on the server and has a simple search (by action and a date range, plus actor or target where cheap), kept in the URL. Personal data rules of the audit log stay as they are.

## Tasks

- T1 [S1, S2] worker; pending; site editor FAQ tab; commit -.
- T2 [S3, S4, S5] worker; pending; orders list filters and layout, order detail cards, audit pagination and search (API + web); commit -.
- T3 [S1-S5] parent; pending; checks, PR, merge on green check-and-test; commit -.

## Log

- L1 Original request (2026-11-06): "1. Mientras revisemos que dentro del backoffice http://localhost:5173/admin/sitio?tab=preguntas van 0,1,2,3 y como proxima nueva propuesta dice 5 y en realidad es la 4ta. Es un detalle pero corrijamoslo. 2. Tambien dentro de ese tab de Preguntas frecuentes deberia poder minimizar/colapsar cada pregunta para reducir espacio vertical en pantalla. Por defecto que aparezcan colapsadas y solo datos basicos. Si se desea se expande. 3. Dentro de http://localhost:5173/admin/pedidos el buscador por comprobante nommbre o email es demasiado chico y tiene el placeholder cortado. Quiza tambien estaria bien poder buscar por fecha de realizacion desde hasta. 4. En el detalle del pedido se ve desbordada la segunda card o caja mira fijate como el Pago de MP se pierde (screenshot) 5. http://localhost:5173/admin/auditoria deberia ser paginado porque pueden existir muchos registros en un futuro. Y tener algun input de busqueda segun te parezca por criterio. Algo simple."
