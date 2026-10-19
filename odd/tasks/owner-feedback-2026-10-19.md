# Owner feedback round 9 (2026-10-19): simpler checkout, way back to the cart, header and footer details

Checkout without data-source notes or city suggestions, a way back to the cart that keeps what was typed, no newsletter consent on screen, more room around the theme switch, and the footer tagline on its own line.

## Specs

- S1 "No creo que haga falta indicar al usuario de donde obtenemos paises provincias y ciudades en el checkot. De ultima esto puede ser un info tecnico del backoffice o documentacion en el proyecto, el usuario no le interesa eso."
- S2 "El campo de ciudad lo podemos dejar sin busqueda por el momento. Es decir que se escriba tal cual y sin leyenda de "no aparece.." solo proponemos pais y provincia de momento. No borremos las ciudades de la db simplemente no las proponemos, que el usuario la escriba a mano."
- S3 "Una vez que estoy en checkout no uedo volver atras a revisar o modificar el pedido, deberia poder volver a la pantalla anterior para hacer algun cambio. Si el usuario cargo algun dato en el fromulario de checkout lo preservamos no lo limpiamos."
- S4 "Dentro de los consentimientos quitemos la opcion de recibir novedades por email por el momento. Es decir el feature visual removemos, no la funcionalidad en si si es que existe."
- S5 "El boton de theme del sitio esta un poco pegado al carrito. Debemos darle aire y que este un poco separado."
- S6 "En la leyenda en footer de moto garage "Motos, motores y restauraciones en Arrecifes. Arrecifes, Buenos Aires" por "Motos, motores y restauraciones. Arrecifes, Buenos Aires""

## Tasks

- T1 [S1-S6] inline; done; commit "simpler checkout with a way back to the cart".

## Log

L1: "1. No creo que haga falta indicar al usuario de donde obtenemos paises provincias y ciudades en el checkot. De ultima esto puede ser un info tecnico del backoffice o documentacion en el proyecto, el usuario no le interesa eso. 2. El campo de ciudad lo podemos dejar sin busqueda por el momento. Es decir que se escriba tal cual y sin leyenda de "no aparece.." solo proponemos pais y provincia de momento. No borremos las ciudades de la db simplemente no las proponemos, que el usuario la escriba a mano. 3. Una vez que estoy en checkout no uedo volver atras a revisar o modificar el pedido, deberia poder volver a la pantalla anterior para hacer algun cambio. Si el usuario cargo algun dato en el fromulario de checkout lo preservamos no lo limpiamos. 4. Dentro de los consentimientos quitemos la opcion de recibir novedades por email por el momento. Es decir el feature visual removemos, no la funcionalidad en si si es que existe. 5. El boton de theme del sitio esta un poco pegado al carrito. Debemos darle aire y que este un poco separado. 6. En la leyenda en footer de moto garage "Motos, motores y restauraciones en Arrecifes. Arrecifes, Buenos Aires" por "Motos, motores y restauraciones. Arrecifes, Buenos Aires""
L2: Done inline. S1/S2: attribution, city datalist, search and hint removed from the checkout; cities, API and /ubicaciones/ciudades kept; ADR 0012 amended, README updated. S3: "Volver al carrito" link; typed fields kept in the tab's sessionStorage (checkout-draft.ts: allow-listed fields, never consents, never sent), restored on return (country first, then its provinces), cleared on the payment result page; a refused submit keeps the server's copy. S4: newsletter checkbox removed; the server still records marketingEmail (false when absent). S5: theme switch 20px from the cart (was 12px). S6: seed and local brand tagline "Motos, motores y restauraciones."; the city line already came from contact.city. RED: E2E checkout-back 3 of 4 and checkout-location city test failed; checkout-draft module missing. GREEN: web unit 107/107, svelte-check 0, E2E checkout-back + checkout-location + email-check + legal-modal + purchase + buyer-location + layout + theme-toggle 33/33 (purchase updated: the newsletter checkbox is absent).
