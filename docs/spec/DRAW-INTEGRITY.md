# Integridad de participaciones y adjudicación
**Importante:** no define ni autoriza una mecánica de rifa. La modalidad requiere validación legal previa.
1. Registrar versiones inmutables de bases y condiciones, elegibilidad y reglas de cierre.
2. Registrar entradas en ledger append-only, con origen y estado; jamás borrar historia al reembolsar.
3. Cerrar en fecha, resolver operaciones en tránsito según reglas, producir snapshot canónico ordenado y hash SHA-256.
4. Publicar hash/manifest sin PII; conservar evidencia verificable y sello temporal cuando aplique.
5. Registrar mecanismo autorizado de selección (fuente oficial/acta, parámetros, algoritmo versionado). Premios por Quiniela: ADR 0014 §3-§4.
6. Registrar adjudicación, suplencia, verificaciones, entrega y evidencias.
7. Publicar un verificador open-source opcional que recompute el hash desde datos seudonimizados, sin filtrar identidades.

## Enmienda propuesta (pendiente de aprobación)
[ADR 0024](../adr/0024-vacant-prizes-drawn-in-app.md) (estado: propuesto) propone que un premio vacante se sortee en la aplicación entre los cupones del manifiesto publicado, sin reabrir ventas. La semilla saldría del extracto oficial y el algoritmo versionado sería `sortea.vacant-draw.v1`. Mientras el dueño no lo apruebe, rigen el punto 5 y ADR 0014 §5 sin cambios.
