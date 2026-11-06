# ADR 0018: Checkout Pro through the Mercado Pago Orders API

Status: accepted, 2026-11-06, after a paid and refunded test order read through the adapter (odd/tasks/mercadopago-orders-api.md, T2 and L6). Amends ADR 0002 (payment confirmation) and ADR 0006 (reconciliation); keeps ADR 0017 (account history).

## Context

Checkout used Checkout Pro through the Preferences API: `POST /checkout/preferences`, then payment webhooks read with `GET /v1/payments/{id}`, and reconciliation with `GET /v1/payments/search`.

Mercado Pago's Checkout Pro reference now lists two paths: "Via Orders API (Recommended)" and "Via Preferences API (Legacy)". It says: "The Preferences API will continue to be supported, but new features will only be available in the Orders API. If you are starting a new integration, use the Orders API." No end-of-support date has been announced.

The platform has no real sales yet. Migrating now avoids migrating later with payments in flight. Owner decision: "Sí, migrar antes de producción".

## Decision

- Checkout creates a Checkout Pro order (`POST /v1/orders`, `type: online`, `processing_mode: manual`) with the order's account and redirects the buyer to its `checkout_url`. The request keeps the earlier rules: items and total, payer with identification, the order reference as `external_reference`, return URLs with auto return on approval, the one-hour expiry (as a duration), the statement descriptor and an idempotency key.
- Webhooks: the application's "Order (Mercado Pago)" event (and chargebacks) is enabled in the Mercado Pago panel, with the same notification URL per organization. The signature check is unchanged, with the order id lowercased in the manifest as Mercado Pago requires. The order is read with the account whose signature validates (ADR 0017), and its payments decide the platform order's state.
- The merchant check compares the order's seller (`user_id`) with the account's merchant id.
- Reconciliation searches orders by creation date and re-reads the platform's own orders by id (below).
- The local simulator emulates orders instead of preferences.
- The Preferences code path is removed.

### One Mercado Pago order per checkout

The Mercado Pago order id (`ORD...`, `ORDTST...` for test orders) is the provider payment id the platform stores (`payments.provider_payment_id`), and it is kept on the order (`orders.provider_preference_id`, mapped as `providerCheckoutId`; the column keeps its name, so no migration). A checkout has one payment row however many attempts the buyer makes: a rejected attempt and a later approval update the same row. Rows stored before keep their ids; an id that is not an order id reads as not found, and reconciliation keeps those rows as history (Consequences).

### Create order

| Field | Value |
| --- | --- |
| Header `X-Idempotency-Key` | the platform order id (UUID) |
| `type`, `processing_mode` | `online`, `manual` |
| `total_amount` | sum of the items, a decimal string from minor units (`"27500.05"`) |
| `items[]` | `external_code` (variant id or `delivery`), `title`, `quantity`, `unit_price` (decimal string) |
| `external_reference` | the order reference |
| `expiration_time` | ISO 8601 duration from now to the order's `expiresAt`, rounded down, at least a minute (`PT1H`, `PT59M30S`) |
| `config.statement_descriptor` | organization name, first 22 characters |
| `config.online` | `success_url`, `failure_url`, `pending_url` (the result page) and `auto_return: approved` |
| `payer` (production accounts) | `email`, `first_name`, `last_name`, `identification { type, number }` |
| `payer` (sandbox accounts) | not sent. A test seller refuses real parties (spike L4), so a Mercado Pago test buyer logs in to pay |

No notification URL is sent: the order event is configured per application in the panel. `config.online.callback_url` is not sent.

### Read order (`GET /v1/orders/{id}`)

| Platform field | From the order |
| --- | --- |
| status | `status`, mapped by `mapMercadoPagoStatus` (table below); `status_detail` stored as reported |
| amount | `total_amount` in minor units. Not `total_paid_amount`, which includes financing the buyer pays |
| currency | `currency` (ARS when absent) |
| merchant (collector id) | `user_id`, the seller |
| approved at | `last_updated_date` of a processed order; the platform keeps the first approval it saw |
| refunded | sum of processed `transactions.refunds[].amount`; the whole amount for a `refunded` order that lists none |
| attempts | `transactions.payments[].length`; an order with none has no payment facts |
| fee, net, release | not in the order: read from the order's payment (below) |

| Order `status` | Platform payment status | Platform order |
| --- | --- | --- |
| `created` | `pending` | no payment row while there are no attempts |
| `action_required` | `pending` | stays pending |
| `processing` | `in_process` | stays pending |
| `processed` (`accredited`, `partially_refunded`) | `approved` | paid; a partial refund is reported, not modelled (ADR 0006) |
| `failed` | `rejected` | payment failed, can still be approved |
| `canceled`, `expired` | `cancelled` | payment failed |
| `refunded` | `refunded` | refunded, coupons voided |
| `charged_back` | `charged_back` | charged back, coupons voided |
| anything else | `pending` | unknown never approves |

### Payment read (`GET /v1/payments/{id}`): fees, net and release

The Orders API reports no fee, net amount or release date. The Payments API does, for payments made through an order (spike L6). When an order read by id (`getOrder`: webhooks, reconciliation re-reads, "apply provider state") is `processed`, `refunded` or `charged_back`, the adapter reads its payment with the same account:

| Platform field | From the payment |
| --- | --- |
| payment id | the `reference_id` (or `reference.id`) of the order's last `transactions.payments[]` entry with status `processed`, `refunded` or `charged_back`; only a numeric id is read |
| fee | sum of `fee_details[].amount` with `fee_payer: collector`, in minor units; fees the buyer pays (financing) are not the seller's cost. An empty list is a fee of zero |
| net | `transaction_details.net_received_amount`, in minor units |
| release | `money_release_date`, `money_release_status` |

Rules:

- One extra request, only when it can add data: never for created, action-required, processing, failed, canceled or expired orders, nor for an order without a numeric payment reference. The orders search makes no payment reads (a run can bring thousands of orders); those orders get their fees when they are read by id.
- A failed payment read (any error, 404 included, or a timeout) never fails the order read, the webhook or the reconciliation run: the fields stay null and the failure is logged with the order and payment ids and the HTTP status, never credentials. A missing or unreadable field stays null.
- A read with a null field never erases a stored value: the confirmation upsert keeps the stored fee, net, release date and status (`coalesce`, like the first approval), and a reconciliation re-read only writes the fields it knows. A newer known value (the release status turning `released`) replaces the stored one.

### Webhook

Only `type=order` (or `topic=order`) notifications are acted on. Other topics (`payment`, `merchant_order`, ...) answer 200 and change nothing, signed or not, so Mercado Pago stops retrying them; they are recorded as `ignored_topic`. Mercado Pago also notifies the creation of an order: an order without payment attempts records `no_payment` and writes nothing, so an unpaid checkout never leaves a pending payment row behind. Account pinning, the search across signing accounts and `merchant_mismatch` are those of ADR 0017.

A payment row only updates for its own order. When the provider id read is already stored for another platform order (seen locally when the old payment simulator reused ids after a restart), the upsert's conflict update is guarded by `payments.order_id = excluded.order_id`, so neither order changes: the notification records `payment_order_mismatch`, an audit `payment.rejected_mismatch` names the provider id and the stored order id (no personal data), the dashboard counts it with the other rejected payments, and the answer is 200 so Mercado Pago stops retrying. Same-order updates (replays, refunds, chargebacks, status changes) are unaffected.

### Reconciliation

The Orders search filters only by creation date (`begin_date`, `end_date`, 50 per page) and has no last-update filter. A run of the window `[from, to]` (as in ADR 0006: from the previous run's end minus 30 minutes, at most 31 days) does two things for the active account and every retired account with orders created within 180 days (`RETIRED_ACCOUNT_HORIZON_MS`):

1. **Orders the platform may not know.** It searches the orders created from `from` minus the order TTL (an order created just before the window can be paid in it) to `to`, one day of creation dates at a time. This finds paid orders with no platform payment (`payment_missing_in_system`, including an order whose id the platform never stored) and paid orders with the platform's reference format that no order has (`unknown_reference`). It also probes each account: a retired account Mercado Pago refuses becomes `account_unavailable`. A run that reaches 5,000 orders stops between days and the next run continues there.
2. **Orders the platform knows and that can still change.** It re-reads them by id, each with its order's account:
   - up to 200 of: payments with an open item; platform orders that could still be paid in the window (pending, failed or expired, not yet past their expiry), which finds a lost approval; payments still pending or in process within the horizon; payments the platform touched in the window;
   - up to 200 approved payments within the horizon, which can still be refunded or charged back, taken in turns by id. Each comes up about once every `ceil(approved / 200)` runs. Refunded and charged-back payments, and payments older than the horizon, are not re-read;
   - up to 100 unpaid platform orders (pending, failed or expired) with a Mercado Pago order id created within the last 7 days (`LATE_APPROVAL_HORIZON_MS`), also in turns by id, each with its own account. This budget is separate: it never takes slots from the two lists above. It finds an approval that lands after the one-hour expiry when every notification was lost: a cash ticket (Rapipago, Pago Fácil) is paid until its own due date and credited one or two business days later, and a card payment in manual review is decided within about two business days. Seven days covers both across a weekend or a holiday. An order approved later than that is found only when its notification arrives.

A turn starts where the previous run's turn stopped in the list ordered by id. Orders enter and leave the lists between runs, so `ceil(N / budget)` runs is the typical gap, not a bound: in simulations with churn the longest gap was about 1.5 times that for time-ordered ids (Mercado Pago's `ORD...` ids) and up to about 3 times for random ids. What holds is that every order within its horizon keeps coming up: an approval within 7 days of the purchase is found once that order's turn comes up, usually within a few hours at current volumes.

Results are merged by order id, so an order found by both is examined once. The comparison rules, items and resolution are those of ADR 0006.

**Cost per run.** Searches: one request per searched account and day of the window, plus one per extra 50 orders. A scheduled run every 30 minutes covers about two hours of creation dates, so one request per account. Re-reads: at most 500 `GET /v1/orders/{id}` (200 + 200 + 100), each followed by one `GET /v1/payments/{id}` when the order took money (Payment read): the 200 approved orders in turns always, the 200 priority re-reads when they are approved, refunded or charged back, the 100 late-approval re-reads only when one turned out approved. So a run makes at most 1,000 reads, about 700 with every budget full (500 orders plus the 200 approved in turns); at 48 runs a day, at most 48,000 reads, of which at most 24,000 are payment reads. Webhooks add one payment read per notification of a paid, refunded or charged-back order. Of the order reads, at most 4,800 a day are late-approval reads. With 2,000 approved orders in the last 180 days each is re-read about every 10 runs (typically 5 hours), with 20,000 about every 100 runs (about two days). With 1,000 unpaid orders in the last 7 days (abandoned checkouts included) each is re-read about every 10 runs (typically 5 hours), with 10,000 about every 100 runs (about two days); a lost late approval is typically found within that time, and in the worst simulated case within about three times it.

**Settlement reports** still name payments by Mercado Pago's numeric payment id. A movement whose id the platform does not store is matched by its `EXTERNAL_REFERENCE`, the order reference.

## Spike results (2026-11-06)

A sandbox order with no payer, paid in a private window as a guest with a test card and a test-style email, was read through the adapter: status processed/accredited mapped to approved, amount 150000 minor units, currency ARS, the seller from `user_id`, the approval time from `last_updated_date`. A full refund (`POST /v1/orders/{id}/refund`) turned it into refunded with `refundedMinor` 150000 and `transactions.refunds[]` (amount as a decimal string, status processed). The orders search found it. `GET /v1/payments/{reference_id}` of the order's payment still answers for payments made through an order and reports the fee (`fee_details`, e.g. `mercadopago_fee` 61.5 paid by the collector), the net amount (`transaction_details.net_received_amount` 1438.5) and the release date and status, which the Orders API omits. The adapter reads them from there (Payment read, 2026-11-06).

## Open points (spike)

1. Whether a webhook URL can be set per order or only in the panel.
2. Whether `GET /v1/payments/{id}` and `/v1/payments/search` still return payments made through an order. Answered for `GET /v1/payments/{id}`: yes (spike L6); the adapter reads fees, net and release from it.
3. Whether refunds made from the Mercado Pago dashboard notify the order.
4. A paid test order: confirm the shape of a processed, refunded and charged-back order (`transactions.refunds[]`, `user_id`, `last_updated_date`), the notification of an order's creation, and that a sandbox order without `payer` is paid by a logged-in test buyer.
5. Whether the account money report's `SOURCE_ID` is the payment's numeric `reference.id` and its `EXTERNAL_REFERENCE` the order reference.

## Consequences

- Operators enable the order event in each Mercado Pago application (setup guide and console).
- Payment ids change format (`ORD...` for new purchases). Stored payments keep their provider ids.
- Fees, net and release date come from the order's payment (Payment read). The finance view counts them as unknown only for payments whose payment read failed every time, or that were stored before 2026-11-06 and are not re-read again; credited money still comes from settlement reports. With the net and release date stored, the settlement checks work for orders again: `settlement_amount_mismatch` also compares the settled net with the payment's net (a warning), and `settlement_missing` fires for an approved payment whose release date falls in the report's period without its sale in it. Both skip a payment whose net or release date is unknown.
- Reading the payment adds at most one request per order read by id (see Cost per run).
- The provider export lists orders created in the period, since the search filters by creation date only.
- A lost refund or chargeback of an approved order within the horizon is typically found within about `ceil(approved / 200)` runs instead of the next run, and a lost late approval within about `ceil(unpaid in 7 days / 100)` runs (longer when many orders enter or leave the lists between runs, see Reconciliation).
- Payments stored before the Orders API hold numeric Payments API ids (and their orders a preference id). Production has none; local and staging do. Reconciliation keeps them as history: it never re-reads them by id, because `GET /v1/orders/{id}` would answer 404 and raise false `payment_missing_at_provider` items that "apply provider state" cannot resolve, and the order search never returns them. A run closes any open `payment_missing_at_provider` item of such an id as cleared, with a note saying so. Other open items of those ids stay for a person to accept.
