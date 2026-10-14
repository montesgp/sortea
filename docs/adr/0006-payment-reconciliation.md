# ADR 0006: Reconciliation runs in the API, and only people resolve differences

Status: accepted, 2026-10-14

## Context

FR-PAY-05 and AC-09 require detecting a missing payment, a different amount, a refund and a settlement discrepancy, then showing the evidence to a person. FR-PAY-06 requires telling gross, fees, refunds, estimated net, credited and available money apart, without inferring a balance from approved sales. Webhooks can be lost, and Mercado Pago can change a payment later (refunds, chargebacks).

## Decision

- **Where it runs.** Reconciliation lives in the API, the only process that opens an organization's Mercado Pago credentials (ADR 0004). The worker is only the clock: every five minutes it calls `POST /internal/reconciliation/run-due` with the internal token, and the API checks each organization whose last check is older than `RECONCILE_INTERVAL_MINUTES`. Finance can also run it on demand.
- **Operations.** A run reads the account's payments by last update (`/v1/payments/search`) over a window that starts where the previous run ended, with a 30-minute overlap. It also re-reads, one by one, every payment the platform touched in that window and every payment with an open difference, so a payment that exists only in the platform is found too.
- **Settlements.** Finance uploads Mercado Pago's account money report (CSV, English headers). Its movements are stored append-only and idempotently per movement, then compared with the payments involved and with the approved payments that should have been released in the report's period.
- **Findings.** Each difference is an item with a stable fingerprint (`kind:payment id`): the same difference found again updates the open item instead of opening another. One run per kind and organization at a time; a run stuck for 30 minutes is marked failed.
- **Resolution.** Items close in three ways only: *apply provider state* re-reads the payment and applies it through the same confirmation code as a webhook; *accept* records a person's explanation; *cleared* happens when a later run no longer finds the difference. Nothing sets a payment as approved by hand. Every resolution and export is audited.
- **Money.** Payments keep the fees, net, refunded amount and release date that Mercado Pago reports. Credited money comes only from settlement reports. Available balance and payouts are shown as unknown until the provider can state them.
- **Access.** `finance.view` for owners, finance and auditors; `finance.reconcile` for finance managers and platform staff. Owners consult finances (PRD §4).

## Consequences

- A lost webhook is caught within one interval and fixed with one verified click, which also allocates participations under the published rules.
- Partial refunds are reported but not modelled: the order stays paid until someone decides.
- Settlement reports go through the web tier's default 512 KB body limit; long periods are uploaded as several reports. Fetching reports through Mercado Pago's report API can replace uploads later without changing the comparison rules.
