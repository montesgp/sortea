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
  - its official date and time, entered in the campaign time zone and stored in UTC;
  - the 20 extracts, as 4-digit numbers in their official order;
  - an evidence URL.
- The draw must take place strictly after the round's manifest was published (ADR 0003: the manifest comes before any selection). A draw at or before that moment, even on the day of the close, is refused, and so is a draw in the future.
- No draw is recorded once the results are published. This is the same rule as a result entered by hand.
- The record is append-only, with one record per campaign round. It keeps the SHA-256 of the manifest it was matched against, and it is shown in the transparency log with its date and time.

### 4. Matching
This is deterministic and pure (domain). The platform adds no randomness.
- Walk the extracts 1 → 20. An extract **matches** when its number is an eligible coupon in the round's manifest that has not been awarded yet.
- **Prize order** is the prize position, then its creation time, then its id. Prizes that share a position are therefore always ordered the same way.
- **Winners:** matches, in extract order, fill the `quiniela` slots in prize order, then slot order.
- **Alternates:** the matches left over, still in extract order, fill the alternates slot by slot, up to the prize's `alternatesCount`. Slot 1 gets all its alternates before slot 2 gets any. A prize with no alternates passes its leftovers to the next slot, and a vacant slot takes no alternates.
- A repeated extract, or a coupon that already won, is skipped. Exactly one winner per slot.
- The admin sees the matching before confirming. The preview returns a digest (SHA-256) of the recorded data and the result.
- Confirming sends that digest back. The server recomputes the result and refuses the confirmation if the digest differs, for example because a manual award changed which coupons are free. The admin then previews again.
- Confirming writes the `prize_awards` rows, so the existing decision and delivery flow continues unchanged.

### 5. Vacancy and rounds
- A `quiniela` slot with no match is **vacant**.
- If any slot is vacant, the admin reopens the campaign for a new round with a new closing date, announced in the public log. The locked rules do not change.
- Every coupon of the previous rounds keeps playing.
- Closing the round publishes a new manifest (one per round, each with its own hash), and the next draw is recorded for that round.
- Awarded slots stay awarded. The campaign reaches `fulfilled` only when no slot is vacant or pending.

Precise rules:
- **Rounds.** Every campaign has `current_round` (1 at first). Manifests, Quiniela draws, log entries and awards each record the round they belong to. A campaign has at most one manifest and one Quiniela draw per round.
- **Vacant.** A `quiniela` slot is vacant when it has no winner and a Quiniela draw was recorded for the campaign. Before the first draw it is pending. A vacant slot keeps the campaign from `fulfilled` (`prizes_vacant`).
- **Reopening.** Reopening is a dedicated admin action (`POST /admin/campaigns/:id/reopen`, permission `campaigns.manage`). The generic transition never goes from `awarding` back to `open`. It is allowed only:
  - from `awarding`;
  - once the current round's Quiniela draw is confirmed;
  - with at least one vacant slot;
  - once the current round's results are published (`result_published` of that round); otherwise `results_pending`. This keeps every round's results attached to the round they belong to: a round can never be published under the next round's number. The admin campaign page shows the reopen action disabled, with that reason;
  - with a closing date later than now and, if a new draw or stream date is given, that date later than the closing date;
  - through the same compliance gate as opening, including the local demo waiver of ADR 0013;
  - with a locked rule version.
- **What reopening does.** It increments `current_round`, sets the new closing date, and replaces the draw date with the new one or clears it, because the old one has passed. The opening date and the rules stay as they are. It writes an audit entry and a public `round_opened` entry that names the new closing date and the vacant prizes.
- **During the new round.** Coupon numbering continues in the same pool, with the reservations and capacity rules of §1.
- **Closing a round.** The round closes like the first one: after `closesAt` + order TTL. It publishes the round's manifest with every entry of the campaign, eligible and void, from all rounds.
- **Drawing a round.** The round's draw follows §3-§4 against the round's own manifest, and must be later than that manifest's publication. It matches only the slots that are still vacant: awarded slots and manual prizes are left alone. A coupon that already holds an award in any role is skipped.
- **Decisions and deliveries across rounds.** The current round's awards are decided and delivered while the campaign is `awarding`, as before. An earlier round's awards, whose results are already published, can be decided (accepted, declined, voided) and delivered in any status from the reopening (`open`) through `awarding`. A new round never freezes the winners of the previous ones. Alternates are promoted within the award's own round.
- **Results per round.** A `result_published` entry belongs to the round in which it is written. It refuses the Quiniela draw of that round only, so round 1's published results do not block round 2's draw. A manual result stays frozen once any round's results were published, which is today's behavior. From round 2 on, `result_published` is accepted only after the round's Quiniela draw is recorded, so an early entry cannot block that draw.
- **Public pages.** An award is public once its round's results are. Transparency lists each round's manifest (hash, counts, download), each round's draw with the hash of the manifest it was matched against, and the slots each round left vacant once that round's results are published. From round 2 on, the campaign page shows the round, the prizes carried over from earlier rounds and the new closing date.
- **Manifest format.** Manifests are now written as `sortea.manifest.v2`. Its header adds `round` and `entryDigits`, in the order `format, campaignId, round, ruleVersion, entryDigits, closedAt, eligibleCount, voidCount`. Manifests published as `sortea.manifest.v1` stay valid and are never rewritten. Parsing one and serializing it again gives its exact published bytes, so its hash still verifies. The hash is always taken over the exact published bytes. `/public/campaigns/:slug/manifest?round=N` serves a given round's manifest, and without `round` it serves the latest.

## Consequences

- Each sold coupon has the same probability: 1 in 10,000 per extract. A person's chance is proportional to the coupons they hold, and with 20 extracts a vacancy is unlikely unless few coupons were sold.
- Anyone can check a result with the published manifest and the official extracts.
- The manifest format gains the round and the digits. Existing campaigns, whose numbers start at 1, stay valid inside the pool.
- Paid orders that cannot get coupons become refunds. They are visible in reconciliation and never silent.
- The extracts of the 5-digit variant come from a different official draw, which needs its own decision later.
