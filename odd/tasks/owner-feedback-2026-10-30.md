# Owner feedback round 5 (2026-10-30)

Kit image back to the T-shirt with stickers, progressive chances per product, a Google Maps location in the footer, the footer WhatsApp link aligned with the social icons, the Resend setup answer, and the purchase result heading.
Work happens on branch feat/owner-feedback-2026-10-30.

## Specs

- S1 Kit image: "Removamos la gorra o redefinamos la imagen del premio de kit porque quedo fea, despues conseguiremos una real o armada con AI. Que quede como estaba antes la remera con las calcos." The kit prize image returns to the version before commit ce76528 (the T-shirt with the stickers), and the cap credit is removed from CREDITS.md. The kit description is unchanged.
- S2 Progressive chances: "Hagamos coherentes las chances por cada producto. Por ejemplo checklist de viaje 5 a 15.000 conviene comprar 3x15.000 y conseguis +15 chances con 5.000 menos que con el manual tecnico. Se supone que a mas gasto de dinero en algun recurso + chances." Decision (L2): "Que no sea fijo. 1 chance 7.000 pero beneficia a mas chances conforme mas caros sean los productos. Es decir el que compre el producto mas caro de todos deberia tener beneficio respecto de las demas chances". Chances per unit: Calcomanía ($7.000) 1, Checklist de viaje ($15.000) 3, Remera, every size ($45.000) 11, Manual técnico ($50.000) 14. The cost per chance falls as the price rises, and no combination of cheaper products beats a more expensive one. Applied to the seed and to the local demo as a new rules version with a public announcement.
- S3 Location: "en el footer agregaria el punto real de google maps con un icon de posicionamiento tipo google maps para MG: El link es https://maps.app.goo.gl/3PR5ZLqycPPozsAe7". Each organization can set a map link in its contact data (platform console, like WhatsApp). The footer shows it with a location pin icon. The demo organization gets that link. Nothing is hardcoded to a tenant.
- S4 WhatsApp in the footer: "No me gusta mucho el link a WhatsApp como esta, lo veo un poco desalineado de las demas redes que las veo mas prolijas y ordenadas en el footer. El boton esta bien donde esta." The footer WhatsApp link uses the same icon-and-label style and alignment as the social links. The floating WhatsApp button stays as it is.
- S5 Email: "Tenemos pendiente configurar el resender email? Podria quedar separado de vacaverde que es donde tengo configurado ahora? Porque hice una simulacion al menos para ver como llegan los mails sus estilos y los manuales y no me llego nada. La ultima compra revisa cualquier cosa". Answer with evidence (L3). The launch checklist and README explain how to keep it separate in the same Resend account (a second domain and a domain-scoped sending key), and that local mail goes to Mailpit.
- S6 Result heading: "se ve un poco mal el signo de interrogacion de "LISTO" y desalineado el texto del titulo de compra." On the purchase result page, the opening "¡" of "¡Listo! Tu compra está confirmada" renders well in the display font, and the heading lines align on the left edge.

## Tasks

- T1 [S1] parent; pending; restore kit.jpg and CREDITS.md from 4c14123; commit -.
- T2 [S2] worker; pending; seed chances and local rules version 3 with announcement; commit -.
- T3 [S3, S4] worker; pending; per-organization map link (API, console, seed, footer pin icon) and the footer WhatsApp link styled like the social links; commit -.
- T4 [S6] worker; pending; result page heading; commit -.
- T5 [S5] parent; pending; Resend and Mailpit notes in docs/launch/environment-setup.md and README; commit -.
- T6 [S1-S6] gentle-ai-verify; pending; commit -.
- T7 parent; pending; RDD assess, PR, merge on green check-and-test; commit -.

## Log

- L1 Original request (2026-10-30): "Removamos la gorra o redefinamos la imagen del premio de kit porque quedo fea, despues conseguiremos una real o armada con AI. Que quede como estaba antes la remera con las calcos. Hagamos coherentes las chances por cada producto. Por ejemplo checklist de viaje 5 a 15.000 conviene comprar 3x15.000 y conseguis +15 chances con 5.000 menos que con el manual tecnico. Se supone que a mas gasto de dinero en algun recurso + chances. Y en el footer agregaria el punto real de google maps con un icon de posicionamiento tipo google maps para MG: El link es https://maps.app.goo.gl/3PR5ZLqycPPozsAe7 No me gusta mucho el link a WhatsApp como esta, lo veo un poco desalineado de las demas redes que las veo mas prolijas y ordenadas en el footer. El boton esta bien donde esta. Tenemos pendiente configurar el resender email? Podria quedar separado de vacaverde que es donde tengo configurado ahora? Porque hice una simulacion al menos para ver como llegan los mails sus estilos y los manuales y no me llego nada. La ultima compra revisa cualquier cosa". Added the same day: "se ve un poco mal el signo de interrogacion de "LISTO" y desalineado el texto del titulo de compra. Encola para resolver esto" (screenshot of /checkout/resultado).
- L2 Decision on S2. Options offered: one fixed value per chance. Owner answer: "Que no sea fijo. 1 chance 7.000 pero beneficia a mas chances conforme mas caros sean los productos. Es decir el que compre el producto mas caro de todos deberia tener beneficio respecto de las demas chances". The parent proposed 1 / 3 / 11 / 14 (cost per chance $7.000, $5.000, $4.091, $3.571).
- L3 Evidence for S5:
  - Local .env has EMAIL_PROVIDER=smtp, so the worker sends to Supabase's Mailpit (http://localhost:54324), not to a real inbox.
  - The last order MG-M4VB5RA7 (paid, 2026-10-30 10:35 UTC) has its "Compra confirmada" email in Mailpit, with the download links as buttons.
  - Resend's Free plan includes 3 domains. API keys can be sending_access restricted to one domain (domain_id) (resend.com/docs/knowledge-base/what-is-resend-pricing; api-reference/api-keys/create-api-key).
- L4 Local data: rules v2 of tornado-300 is locked with entriesPerUnit remera sizes 10, calcomania 1, checklist 5, manual 15. Prices: calcomania 7000, checklist 15000, remera 45000 (all sizes), manual 50000 (ARS).
