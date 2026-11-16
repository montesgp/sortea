# ADR 0025: Campaign expenses and the campaign result

Status: accepted, 2026-11-15 (odd/tasks/campaign-finance.md)

## Context

The overview ("Resumen") showed the whole organization only, and its "Neto proyectado" was sales − refunds − committed prizes, without Mercado Pago fees or any cost of running the campaign. The owner wants a view per campaign, to charge the campaign's expenses (hosting, domain, parts to restore the prize, labour, fuel) against its projection, and a final recount once it ends (S1, S2, S3).

Two problems showed up in the old formula (L4):

- Refunds were subtracted twice. Gross counted only orders that are `paid` now, and refunds summed the orders that are `refunded` or `charged_back` now, which gross had already left out. A sale of 100 refunded in full showed a net of −100.
- Committed prizes counted only campaigns that were `open`, `closed` or `awarding`, so a fulfilled campaign's prizes dropped out of the organization's projection, and its recount would show prizes 0.

## Decision

- **Expenses belong to a campaign.** `app.campaign_expenses` (migration 0032) keeps one row per expense: the campaign, a category from a fixed list, a free detail of 1 to 200 characters, the amount in integer minor units (> 0) in the organization's currency, and the day it was spent. It carries `organization_id` with the tenant policy. The organization view adds the expenses of every campaign (S4).
- **Fixed categories plus detail.** Tecnología y hosting, Dominio, Repuestos, Mano de obra, Combustible y traslados, Publicidad, Comisiones y bancos, Otros (`packages/domain/src/finance.ts`). The balance groups by category in that order.
- **Who edits.** A new permission, `finance.expenses`, for the organization owner and the finance manager (and the platform). Everyone with `dashboard.view` reads the expenses. Create, edit and delete are audited (`expense.created`, `expense.updated`, `expense.deleted`, target the campaign) with the expense id, category, amount and day; an edit records the fields changed and the before and after of category, amount and day. The detail is free text and is not copied into the audit. Every change publishes `campaign.updated` so the live overview reloads. Expenses stay editable on archived campaigns, because the recount happens after the end; there is no lock.
- **The result formula (S5).** result = sales − refunds − fees − prizes − expenses, in `campaignResult`:
  - sales: every charged order, `paid`, `refunded` or `charged_back`, so a refund is subtracted once. The "Ventas aprobadas" KPI (`grossApprovedMinor`) stays as before, paid orders only;
  - refunds: orders `refunded` or `charged_back`;
  - fees: `payments.fee_minor` of the approved payments of charged orders, as Mercado Pago reported it. A payment without a reported fee counts as zero and is shown as pending (`feesPendingPayments`), never estimated;
  - prizes: the declared value × quantity of a campaign's prizes once it opened: `open`, `closed`, `awarding`, `fulfilled`, or `archived` with a published draw manifest (an archived campaign may never have opened) (`prizesCount`);
  - expenses: the campaign's expenses.
- **Same rule in both views.** `GET /admin/overview` without `campaign` uses all-time sales, fees, prizes and expenses of the organization; with `?campaign=<id>` it counts only that campaign's orders, entries, prizes, deliveries, fees and expenses, and adds the campaign balance. So the organization's projected net equals the sum of the campaign results plus the orders without a campaign (sales − refunds − fees). The response lists the organization's campaigns for the selector. Alerts stay organization-wide. A campaign of another organization answers 404.
- **Projected, then final.** The balance is final (`final: true`) once the campaign is `closed`, `awarding`, `fulfilled` or `archived`; before that it is a projection.

## Consequences

- The projected net changes for every organization: it now subtracts fees and expenses, counts refunded sales once, and counts the prizes of fulfilled campaigns.
- Partial refunds of an order that stays `paid` (`payments.refunded_minor`) are not subtracted, as before. Reconciliation (ADR 0006) remains the place for the exact money credited.
- Prizes are valued at their declared value. A prize declared at 0 (a donated vehicle) costs nothing in the result; what was spent on it is loaded as expenses.
- Fees of payments Mercado Pago has not reported yet make the result look better until they arrive; the pending count says how many are missing.

Addendum (independent verification): a charged-back payment keeps its fee in the total, because Mercado Pago does not return it on a chargeback; a fully refunded payment drops it, as Mercado Pago returns the fee with a full refund.
