# ADR 0016: A free way to take part in purchase-linked campaigns (open decision)

Status: proposed, deferred on 2026-10-28. Not implemented. Resolve with counsel before a real campaign opens paid participations. Then it gets accepted or rejected with the chosen design.

## Context

Today a campaign gives chances only with a purchase. Owner decision (odd/tasks/owner-feedback-2026-10-28.md, L8): "No existe forma de participar sin comprar, no vendemos sorteos nos dedicamos a reparar motos y vender cursos de reparacion y relacionados."

Argentine consumer law prohibits that structure as such. Deception does not need to be present. DNU 274/2019 (Lealtad Comercial), [official text](https://www.argentina.gob.ar/normativa/nacional/decreto-274-2019-322236/texto):

> "ARTÍCULO 14.- Queda prohibido: a) El ofrecimiento o entrega de premios o regalos en razón directa o indirecta de la compra de mercaderías o la contratación de servicios, cuando dichos premios o regalos estén sujetos a la intervención del azar. b) Promover u organizar concursos, certámenes o sorteos de cualquier naturaleza, en los que la participación esté condicionada en todo o en parte a la adquisición de un producto o a la contratación de un servicio."

The rule looks at the conduct, not at the type of business. Being an e-commerce of repairs and courses does not change it. Running no ads does not change it either: the draw itself is the promotion, and the site already tells buyers "Con esta compra sumás +6 chances".

Permitted promotional draws exist outside art. 14 under the regulatory layer:
- Res. SCI 241/2020 art. 5 points to Decreto 961/2017 and Res. 89/1998.
- Res. SIyC 12/2024 sets the medium (website or free phone line) and the size of the "Sin obligación de compra" legend.
- The Ministry's guidance summarizes it: "debe contar con la frase 'SIN OBLIGACIÓN DE COMPRAS' (…) Además, el organizador debe brindar un mecanismo de participación gratuito para aquellos que no deseen adquirir ningún producto." ([source](https://www.argentina.gob.ar/produccion/comercializar-productos/preguntas-frecuentes-lealtad-comercial/publicidad-y-concursos))

What Decreto 961/2017 art. 2-3 asks for, and where the platform stands:

| Requirement | Today |
| --- | --- |
| Full prize list, dates, mechanism, participation requirements | Done: bases and transparency |
| Costs borne by the winner | Done: vehicle condition (S3) |
| Winners published within 10 business days | Done: winners table (S5) |
| Winners list and receipts kept for 3 years | Done: retention (ADR 0010) |
| Mathematical probability of winning | Missing |
| "Sin obligación de compra" and a free participation channel | Missing |

Buenos Aires province: no norm was found that requires the lottery authority (Instituto Provincial de Lotería y Casinos) to authorize free-entry promotional draws. That is absence of evidence, not a confirmation. Other provinces (Neuquén, Río Negro, Mendoza, Salta, Tierra del Fuego) have their own authorization regimes.

## Proposed design (to confirm with counsel)

A "Participá sin comprar" page for each open campaign.

1. The person enters the same data as at checkout: name, document, email and city. They make the adult declaration (S11 of odd/tasks/owner-feedback-2026-10-28.md) and accept the bases and the privacy policy.
2. A code is emailed to them, reusing the `/consulta` emailed-code flow. The coupon is issued only once they confirm it.
3. They get one free coupon per document per campaign, from the same pool (ADR 0014). It plays the draw like a bought coupon and shows its origin in the ledger.

Abuse controls:

| Risk | Control |
| --- | --- |
| Repeated requests with one document | Unique constraint: one free coupon per campaign and document |
| Many email accounts | One free coupon per email, confirmed by code |
| Bots | Captcha (for example Cloudflare Turnstile) and rate limits per IP |
| A third party's or an invented document | Prize delivery already requires identity verification. A coupon requested with someone else's document is worthless to the requester: the prize goes to the real holder or is voided and passes to the alternate. This is the same defense the checkout relies on today (ADR 0004). |

Also required:
- The "Sin obligación de compra" legend and the probability of winning, in the bases and wherever the campaign promises chances.
- The legal texts updated to describe the channel.

## Open questions for counsel

1. Is one free chance per person enough? A purchase gives several chances (for example 10 per product). Could the difference be read as participation "condicionada en parte" to the purchase?
2. Is any authorization needed in Buenos Aires province, and in other provinces if buyers from there take part?
3. May the number of free coupons be capped so the 0000-9999 pool is not used up? If so, how is the cap disclosed?
4. How should the probability of winning be stated, given that the number of coupons is only known at the close?

## Consequences while deferred

- Real paid participations stay closed until the legal approval is on record (AC-12, ADR 0015). This ADR should be resolved before anyone records that approval.
- The local demo keeps rehearsing purchase-only chances under the compliance demo waiver (ADR 0013).
- Implementation estimate when resumed: medium. Most of it already exists: emailed codes, coupons, consents, the adult declaration, award verification and voiding. The new parts are the page and endpoint, the unique constraints, the captcha, and the legend and probability in the bases.
