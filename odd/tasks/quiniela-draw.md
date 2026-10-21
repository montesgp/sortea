# Quiniela draw with a 0000-9999 coupon pool (2026-10-21)

Each chance is a coupon numbered within 0000-9999 (a capped pool); winners come from the 20 extracts of an official Quiniela draw; a prize with no matching sold coupon is vacant, the campaign reopens and a new round is drawn later.
Design: docs/adr/0014-quiniela-coupon-draw.md (the spec for every slice). Branch feat/quiniela-draw.

## Specs

- S1 Pool: "Probablemente se esperen menos de 10.000 cupones por campana, siempre que 1 cupon = 1 chance." Coupons are numbered within 0000-9999 (4 digits, shown zero-padded); sales stop when the pool is exhausted. "Mas adelante si esperamos mas vamos con A en 5 cifras" (5 digits later, not now).
- S2 Selection: option A, "Implementar con los 20 extractos": the extracts 1st..20th of the named Quiniela draw are read in order; the first one that matches a sold eligible coupon wins prize 1, the next match prize 2, and so on. "Lo que si debemos garantizar que exista 1 unico ganador por premio."
- S3 Vacancy: "si no se asigno ningun cupon, podria tambien quedar vacante y volver a sortear la proxima ronda de loteria y de paso se abren nuevamente las posibilidades de comprar mas chances o que otros usuarios nuevos participen". Unmatched prizes are vacant; the campaign reopens; existing coupons keep playing; a new manifest is published before the next round.
- S4 Transparency: "Todo va a estar correctamente documentado y transparente." The draw source, date, the 20 extracts, the matching and any vacancy are public in the transparency log; an ADR documents the mechanism.
- S5 Owner decisions (L4): mechanism "Se elige por premio" (quiniela or manual per prize); alternates "El siguiente extracto que coincida"; full pool "El checkout no deja comprar más chances" (pending orders reserve; a payment that still cannot fit is flagged for refund); several prizes "Sí, cada cupón es independiente".

## Tasks

- T1 [S1, S5] gentle-ai-worker (context backstop); pool 0000-9999 per campaign (entry_digits), sequential from 0, reservations on pending orders, pool_exhausted in quote/order, refund flag on late payments, zero-padded display everywhere; ADR 0014 §1.
- T2 [S2, S4, S5] gentle-ai-worker; prize mechanism, append-only Quiniela draw record, pure matching (winners then alternates), admin record/preview/confirm, transparency; ADR 0014 §2-4.
- T3 [S3, S4] gentle-ai-worker; vacancy, rounds, reopen with new close date, manifest per round; ADR 0014 §5.
- T4 [S1-S5] verification per slice (risk items 1, 3, 4).

## Log

L1: "Si hacemos el commit de todo esto y lo promovemos a main. El tema del mecanismo esta bien que sea por loteria nacional porque de esa manera quedamos cubiertos por un ente regulador legal y se asume que no podemos modificar ese ente con lo cual ya ganamos parte de la legalidad y autorizacion de la plataforma. Pero tenemos que encontrar un mecanismo tal que la persona que consigue mas chances, tambien se reflejan esas chances dentro de la loteria. Como podemos plantear esto? Es igual que la loteria, quien compra mas tickets mas posibilidades tiene, o el loto por ejemplo. Lo que si debemos garantizar que exista 1 unico ganador por premio. si es necesario podemos usar el DNI de la personas 10 veces si compro algo que le dio 10 chances o no se"
L2: "Probablemente se esperen menos de 10.000 cupones por campana, siempre que 1 cupon = 1 chance. El tema es lo que indicas, si no se asigno ningun cupon, podria tambien quedar vacante y volver a sortear la proxima ronda de loteria y de paso se abren nuevamente las posibilidades de comprar mas chances o que otros usuarios nuevos participen, es lo mismo al fin y al cabo. Me gusta la opcion A por sencillez para el usuario, que entienda facil como participa. Mas adelante si esperamos mas vamos con A en 5 cifras eso no habria problema. Todo va a estar correctamente documentado y transparente" Then chose "Implementar con los 20 extractos".
L3: Exploration (gentle-ai-explore mvhmail5-2-n52x): numbers start at 1, contiguous, no cap (confirm.ts:190-206, schema.ts:272); campaign row FOR UPDATE serializes allocation; checkout never checks a pool; one manifest per campaign (unique index) and no path back from closed; awards are typed by hand per slot with alternates (awards.ts:~190-270), evidence is free-text draw_events; awards route rejects entry 0 (min(1)); numbers shown as #n unpadded in result page, /consulta, email, transparency, admin. Seed FAQ says the main prize comes from the lottery and the others from the app Sorteos. Open decisions: which prizes use the Quiniela, alternates, pool exhaustion with paid orders, one person winning several prizes.
L4: Owner answers: "Se elige por premio (recomendado)"; "El siguiente extracto que coincida (recomendado)"; "El checkout no deja comprar más chances (recomendado)"; "Sí, cada cupón es independiente (recomendado)". ADR 0014 written.
