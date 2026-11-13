# Integridad de participaciones y adjudicación
**Importante:** no define ni autoriza una mecánica de rifa. La modalidad requiere validación legal previa.
1. Registrar versiones inmutables de bases y condiciones, elegibilidad y reglas de cierre.
2. Registrar entradas en ledger append-only, con origen y estado; jamás borrar historia al reembolsar.
3. Cerrar en fecha, resolver operaciones en tránsito según reglas, producir snapshot canónico ordenado y hash SHA-256.
4. Publicar hash/manifest sin PII; conservar evidencia verificable y sello temporal cuando aplique.
5. Registrar mecanismo autorizado de selección (fuente oficial/acta, parámetros, algoritmo versionado). Premios por Quiniela: ADR 0014 §3-§4.
6. Registrar adjudicación, suplencia, verificaciones, entrega y evidencias.
7. Publicar un verificador open-source opcional que recompute el hash desde datos seudonimizados, sin filtrar identidades.

## Premios vacantes (ADR 0024, aceptado)
Un premio de Quiniela que el sorteo de la ronda deja vacante se sortea en la aplicación, sin reabrir ventas ([ADR 0024](../adr/0024-vacant-prizes-drawn-in-app.md)). Participan los cupones `eligible` que no tienen ningún premio. El API elige con `crypto.randomInt` y guarda los premios, el registro (cupones candidatos, su SHA-256 y las elecciones), la entrada del log público y la auditoría en una sola transacción, antes de que la pantalla del sorteo lo muestre; volver a correrlo devuelve el mismo resultado. La aleatoriedad la pone la plataforma: el hash prueba que la lista publicada no cambió después, no es un compromiso previo al sorteo. El panel ya no ofrece reabrir; la acción del API sigue para las campañas ya reabiertas (ADR 0014 §5). Los textos de las bases quedan para antes del lanzamiento (S11).

**Lista de candidatos verificable.** La transparencia publica la cantidad y el SHA-256 de los cupones candidatos, y la lista como archivo de texto (`GET /public/campaigns/:slug/app-draws/:round/candidates.txt`; en el sitio, «Descargar la lista de cupones (.txt)»): exactamente el texto que se hasheó, un número por renglón en orden ascendente, sin nombres y sin salto de línea al final. `sha256sum <archivo>` tiene que dar el hash publicado. El tablero de premios y el detalle de la campaña solo cuentan los cupones en juego; la lista completa la carga solo la pantalla del sorteo (odd/tasks/owner-feedback-2026-11-11b.md, T13).

**Unidades desiertas.** Una unidad que ya nadie puede ganar se declara desierta con un motivo (ADR 0024 §7): una vacante cuando ya no queda ningún cupón sin premio para sortearla y ningún resultado cargado a mano se puede corregir todavía (una corrección podría liberar cupones), o una cuyo ganador y todos sus suplentes rechazaron o fueron anulados. Mientras el sorteo en la app todavía pueda darle ganador, primero se sortea. La declaración es append-only, queda en la auditoría y se publica como «Desierto» con su motivo junto con los resultados de la ronda; la unidad cuenta como resuelta para terminar la campaña y queda cerrada para siempre: ni el sorteo de la Quiniela de una ronda posterior ni el sorteo en la app le dan ganador, y no se anuncia como vacante al reabrir.
