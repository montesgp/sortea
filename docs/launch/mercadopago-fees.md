# Mercado Pago fees for Checkout Pro (Argentina)

What Mercado Pago charges on a Checkout Pro sale (the buyer is redirected to Mercado Pago and back), and what the platform can and cannot see. Researched on 2026-11-06; Mercado Pago changes its prices, so check the official pages before relying on the numbers.

## The commission

The seller pays a percentage of each sale, plus IVA. There is no fixed per-sale fee in Argentina. The percentage depends on three things the seller controls or that belong to the account:

- **When the money is released** (plazo de acreditación), chosen per channel in Mercado Pago: Tu negocio → Costos y cuotas → Checkout.
- **The province** of the account's registered address.
- **The payment method**, mainly installments without interest, which cost extra.

Official Checkout Pro page (https://www.mercadopago.com.ar/herramientas-para-vender/check-out, undated): "En 35 días Pagás 1,49% +IVA", "En 18 días Pagás 3,39% +IVA", and 4,39% and 6,29% +IVA for 10 days and instant release; "Los costos pueden variar de acuerdo a los impuestos provinciales."

By province (secondary source citing Mercado Pago's help articles 33399 and 33392, checked 2026-11-02; percentages plus IVA):

| Province | Instant | 10 days | 18 days | 35 days |
| --- | --- | --- | --- | --- |
| CABA, Corrientes, Jujuy, La Pampa, Misiones, Neuquén, Salta, San Luis, Tierra del Fuego, Tucumán | 6.29 | 4.39 | 3.39 | 1.49 |
| Buenos Aires, Chubut, Córdoba, Entre Ríos | 6.60 | 4.61 | 3.56 | 1.56 |
| Chaco, San Juan, Santa Cruz, Santiago del Estero | 6.19 | 4.32 | 3.34 | 1.47 |

- Foreign credit cards: 3% more (secondary sources).
- Installments without interest offered by the seller (secondary source, rates from 2026-02-10, plus IVA): 2 installments 7.79%, 3 → 10.49%, 6 → 18.69%, 9 → 26.49%, 12 → 32.29%, 18 → 41.59%. Installments with interest are paid by the buyer.

Our sandbox payment (ARS 1,500, credit card, one installment, released after 18 days) reported a fee of 61.50: 3.39% plus IVA (21%) is 4.10%, which matches.

## Taxes on top of the commission

Mercado Pago is a tax collection agent. Depending on the account's tax status and province it also withholds or collects IVA, Ganancias, Ingresos Brutos and the tax on bank debits and credits. That money goes to the tax authorities, not to Mercado Pago. Some of these are charged on the payment and some later as separate movements.

## What the platform stores

For each paid order the platform reads the Mercado Pago payment and stores (ADR 0018):

- the **fee**: the Mercado Pago commission paid by the seller, including IVA (`fee_details`);
- the **net**: what Mercado Pago reports as received (`net_received_amount`);
- the **release date**.

The net is a good estimate of what reaches the account, but **it is not guaranteed to include every tax withholding**: withholdings charged later appear only in Mercado Pago's account reports (released money and account activity), which reconciliation compares against. For the exact amount received at the end of a campaign, use those reports or the reconciliation of the period.

## How to lower the commission

- A longer release term costs much less (1.49% at 35 days against 6.29% instant, plus IVA).
- Not offering installments without interest avoids their extra cost.
