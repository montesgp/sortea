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
