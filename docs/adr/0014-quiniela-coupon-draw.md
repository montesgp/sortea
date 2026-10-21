# ADR 0014: Coupons numbered within the Quiniela range, prizes drawn from its 20 extracts

Status: accepted, 2026-10-21. Amends ADR 0003 (Entries, Close, Selection). The campaign's bases must describe this mechanism, and legal approval still gates opening (AC-12).

## Context

Each chance is a numbered coupon (ADR 0003). The owner wants the winners to come from an official lottery draw that nobody can influence: "quien compra mas tickets mas posibilidades tiene", "debemos garantizar que exista 1 unico ganador por premio". Today:
- Numbers start at 1 with no upper bound (`campaigns.next_entry_number`).
- A closed campaign cannot reopen, and it has a single manifest.
- Winners are typed in by hand, slot by slot.

An official draw only yields numbers within a fixed range. Mapping an unbounded count of coupons onto that range would favour some coupons, so the coupons themselves have to live in the draw's range.

Owner decisions (odd/tasks/quiniela-draw.md):
- Option A: a 0000–9999 pool, 1 coupon = 1 chance; 5 digits later if needed.
- The 20 extracts of a Quiniela draw are read in order.
- If nothing matches, the prize is vacant: the campaign reopens and a later draw decides it.
- The mechanism is chosen per prize.
- Alternates come from the next matching extracts.
- When the pool is full, checkout refuses more chances.
- Every coupon is independent, so one person may win several prizes.

## Decision

### 1. Pool
- Each campaign has `entry_digits` (4 now), so its pool is 0 … 10^digits − 1. Numbers are allocated sequentially from 0 under the campaign row lock, as today, and shown zero-padded ("N.º 0042") wherever a coupon appears: result page, /consulta, email, transparency, admin.
- Capacity is `pool − allocated − reserved`. **Reserved** is the chances of unexpired `pending_payment` orders for the campaign, stored on each order when it is created.
- Order creation locks the campaign row and refuses, with `pool_exhausted`, a cart that asks for more chances than remain. The quote reports what remains, so the cart can say so before paying.
- A payment that confirms with no room left (for example, after its reservation expired) keeps the purchase and allocates nothing. It raises a critical reconciliation item so finance refunds it. It never allocates a number outside the pool.
- When nothing remains, the campaign no longer promises chances: no badges, and the campaign page says the coupons are sold out.

### 2. Mechanism per prize
- Every prize has `mechanism`: `quiniela` or `manual` (the default, today's flow). Manual prizes keep being recorded by hand.

### 3. Recording a Quiniela draw
- After closing, an admin records the draw:
  - the source (for example "Quiniela de la Ciudad, Nocturna");
  - its date;
  - the 20 extracts, as 4-digit numbers in their official order;
  - an evidence URL.
- The record is append-only, with one record per campaign round, and it is shown in the transparency log.

### 4. Matching
This is deterministic and pure (domain). The platform adds no randomness.
- Walk the extracts 1 → 20. An extract **matches** when its number is an eligible coupon in the round's manifest that has not been awarded yet.
- **Winners:** matches, in extract order, fill the `quiniela` slots in prize order (prize position, then slot).
- **Alternates:** the matches left over, still in extract order, fill each slot's alternates in the same slot order, up to the prize's `alternatesCount`.
- A repeated extract, or a coupon that already won, is skipped. Exactly one winner per slot.
- The admin sees the matching before confirming. Confirming writes the `prize_awards` rows, so the existing decision and delivery flow continues unchanged.

### 5. Vacancy and rounds
- A `quiniela` slot with no match is **vacant**.
- If any slot is vacant, the admin reopens the campaign for a new round with a new closing date, announced in the public log. The locked rules do not change.
- Every coupon of the previous rounds keeps playing.
- Closing the round publishes a new manifest (one per round, each with its own hash), and the next draw is recorded for that round.
- Awarded slots stay awarded. The campaign reaches `fulfilled` only when no slot is vacant or pending.

## Consequences

- Each sold coupon has the same probability: 1 in 10,000 per extract. A person's chance is proportional to the coupons they hold, and with 20 extracts a vacancy is unlikely unless few coupons were sold.
- Anyone can check a result with the published manifest and the official extracts.
- The manifest format gains the round and the digits. Existing campaigns, whose numbers start at 1, stay valid inside the pool.
- Paid orders that cannot get coupons become refunds. They are visible in reconciliation and never silent.
- The extracts of the 5-digit variant come from a different official draw, which needs its own decision later.
