# ADR 0024: Vacant prizes are drawn in the application, without reopening sales

Status: accepted, 2026-11-12 (odd/tasks/owner-feedback-2026-11-11b.md, T9; S5, S10, S11; L2, L14). The decisions in L14 are the owner-revisable defaults this ADR records. It amends ADR 0014 §5 for the back office: a vacancy is drawn in the application instead of reopening the campaign. It amends ADR 0003 "Selection" for vacant units only. The legal approval still gates opening (AC-12, ADR 0015), and this ADR records no approval.

Amended 2026-11-12 for campaigns with thousands of coupons (T13; S12, L18): the board counts instead of listing, transparency publishes the candidate list as a file, and a unit nobody can win any more is declared void (§2, §6, §7, §9; the first two open points are closed).

## Context

ADR 0014 §5 handles a vacant prize by reopening the campaign: sales resume, a new round closes with a new manifest, and a later Quiniela draw decides only the vacant units. With a 0000–9999 pool and 20 extracts, a unit goes vacant whenever few coupons were sold: 300 coupons give an expected 0.6 matches. Reopening would then be the normal outcome, and winners would wait weeks.

The owner's notes, verbatim:
- S5: "El sorteo no se reabre, se sortea por aplicación".
- S10: on the closing day, during the official broadcast, the main prize waits for the number "a la cabeza"; "si no sale lo tiramos dentro de la propia app contra todos los datos y numeros existentes reales, debe ser un random y debe ser interactivo", showing every coupon spinning past "con nombres de las personas cortados", so anyone who pauses the screen can see their number took part.
- S11: "Por ahora no te preocupes por los datos estrictos y legales de las campanias porque aun no estamos productivos."

## Decision

### 1. When
- The in-app draw covers the units of `quiniela` prizes that the round's Quiniela draw left without a winner (`vacantQuinielaSlots`, ADR 0014 §5).
- It runs once the round's Quiniela draw is recorded, while the campaign is `awarding`. It may run before or after the round's results are published.
- It runs once per campaign round. A second run returns the stored result and never draws again.
- Until then, the campaign detail tells whoever can operate it where the draw is and when it opens ("Se habilita acá después del cierre, cuando cargues el resultado de la Quiniela y algún premio quede sin cupón ganador."), and while awarding it shows why it is not offered (owner feedback 2026-11-12 S8).

### 2. Candidates
- The candidates are every coupon of the campaign with status `eligible` that holds no award in any role (winner or alternate) and any round.
- They are the coupons already sold: no sales reopen and no coupon is added. A coupon voided after the close (a refund) is not a candidate.
- **Canonical list.** The coupon numbers ascending, zero-padded to the campaign's digits, one per line, `\n` line endings and no final newline (`appDrawCandidateText`). Its SHA-256 and the count are stored and published, and the text itself is the public download of §6, so `sha256sum <slug>-cupones-sorteo-app-ronda-1.txt` prints the published hash.

### 3. Randomness and order
- The API draws with Node's `crypto.randomInt`, a cryptographically secure generator whose output is uniform over `[0, n)`, without replacement (`drawVacantSlots`, `packages/domain/src/app-draw.ts`).
- **Winners first.** Every vacant unit gets a winner in prize order (ADR 0014 §4: position, creation, id), then unit order.
- **Then alternates.** Each unit that got a winner then gets its alternates, unit by unit, up to the prize's `alternatesCount`.
- Winners go first so that, with few coupons left, a prize never stays vacant while an earlier one gets alternates. The draw stops when the candidates run out; a unit still without a winner stays vacant (see Open points).
- Each candidate has the same chance: one coupon is one chance, as everywhere else (ADR 0014 Consequences).

### 4. Recorded before it is shown
One transaction, before the API answers and before any screen shows anything:
- one append-only `app_draws` row per campaign round (migration 0024): the candidates, their SHA-256 and count, the picks, the time and who ran it. Tenant policy and `forbid_mutation` trigger like `quiniela_draws`;
- the `prize_awards` rows, written by the same function as a Quiniela match (`insertSlotAwards`) with `app_draw_id` pointing to the record and the note "Sorteo en la app". The decision, delivery and alternate flow continues unchanged;
- a public log entry (`draw_events`, kind `app_draw`): "Sorteo en la app de los premios vacantes", with the candidate count and hash;
- the audit entry `award.app_draw_recorded` with the round, count, hash and picks.

The campaign row lock serializes concurrent runs, and the unique `(campaign_id, round)` index backs it up. The presentation screen only reveals a decided result, and a reload replays the same one.

### 5. The presentation screen
- The back office shows the result full screen: every candidate spins through the centre with its coupon number and masked name, slows down and stops on the stored winner, with a winner animation.
- Sound comes from the Web Audio API (no audio files) and can be muted. With reduced motion, the screen shows the result without spinning.
- **Side table** (odd/tasks/owner-feedback-2026-11-12.md S3). While the reel runs, a "Ganadores" table to its right lists every pick of the run in draw order, with its role, its prize and a count such as "2 de 4": revealed picks show the coupon and the masked name, the pick on the reel says "Sorteando…" and the rest "Por sortear". A pick fills in its row when it lands, with a short emphasis (none with reduced motion); winners carry the accent and alternates do not. The table is not a live region: the page announces each result once. Screens 860 px wide or less hide it, so the reel and the winner card keep the whole height; the summary lists every pick at the end.
- **Masked names.** The first two letters of the buyer's first name, `***` and the initial of the last name: "Ju*** P." (`maskHolderName`). The coupon number is shown in full.

### 6. Public data
- **Transparency.** The transparency page lists each round's in-app draw next to the Quiniela one: time, candidate count and SHA-256, at once. The picks (prize, unit, role, rank, coupon) are listed once that round's results are published, like any award.
- **Candidate list as a file (T13).** The candidate coupon numbers (numbers only) are not inlined in the page or its JSON, since a campaign can have thousands. The page links "Descargar la lista de cupones (.txt)" to the site's `/sorteos/:slug/sorteo-app/:round/cupones.txt`, which passes through `GET /public/campaigns/:slug/app-draws/:round/candidates.txt` byte for byte: the canonical text of §2, `text/plain; charset=utf-8`, the hash in `x-content-sha256`, cacheable (`public, max-age=3600`) because the record is append-only. It is tenant-scoped like the other public routes and answers 404 for a campaign that is not public or a round without an in-app draw. The page shows the commands to check it: `sha256sum <file>` (Linux), `shasum -a 256 <file>` (macOS), `Get-FileHash <file>` (Windows PowerShell).
- **Void units.** A unit declared void (§7) is listed as "Desierto" with its reason once the results of the round it was declared in are published, and no longer as vacant.
- **Winners.** The winners section and the transparency awards carry `source: "app_draw"`, which the site labels "Sorteo en la app". Names follow `winner_publicity` exactly as for any winner (SECURITY.md).

### 7. Reopening
- The back office no longer offers reopening (L14); the in-app draw is the vacancy path.
- `POST /admin/campaigns/:id/reopen` keeps working, unchanged, for campaigns already reopened and for data repair. A campaign that is still in a later round keeps the rounds of ADR 0014 §5.
- A campaign with a vacant unit still cannot reach `fulfilled`. The refusal (`prizes_vacant`) names the way forward: "Hay premios vacantes: sortealos en la aplicación" while a coupon without a prize is left, and "Hay premios vacantes sin cupones para sortear: declaralos desiertos con «Declarar desierto» en Premios y entregas" once none is.
- **Declaring a unit void (T13).** From the awards page, "Declarar desierto" with a required reason (5 to 1000 characters), permission `campaigns.operate`, while the campaign is awarding. It applies to a vacant unit only when no coupon without a prize is left (fewer coupons than vacant units, typically after the in-app draw used them all), counted at the moment of the request, and only once every manual result is settled: while a result typed in by hand still holds awards and can be corrected (`canRecordSlot`: nobody in it decided, results not published), a correction could give its coupons back to the in-app draw, so the declaration is refused (`manual_results_open`) and the awards page says why. With every manual result frozen, the count of coupons left can only go down, so a void declared at zero stays justified, and to an `exhausted` unit, whose winner and every alternate were declined or voided. While the in-app draw can still give a vacant unit a winner it is refused, so a vacancy is never left void by choice. The rule is `canDeclareSlotVoid` (`packages/domain/src/awards.ts`).
  - It is recorded append-only, one per unit, in `prize_slot_voids` (migration 0025, tenant policy and `forbid_mutation` trigger), with the round, the reason, who and when, and audited as `award.slot_declared_void` (unit, round, previous state, reason).
  - The unit then counts as resolved, in every round: `vacantQuinielaSlots` (`packages/domain/src/quiniela.ts`) is the one definition of an open unit and leaves void units out, so the Quiniela match of a later round, the in-app draw, reopening and the public "Premios vacantes que se sortean en esta ronda" never include it. It is no longer vacant and does not block `fulfilled` (nor, after it, archiving). What happens to the prize itself (kept by the organization or another destination) is for the bases (§8).

### 8. Legal texts deferred (S11)
- The platform is in production but not launched. Following S11, this ADR does not add a vacancy policy per rule version, nor bases texts or announcements.
- Before launch, each campaign's bases must describe this mechanism. A bases text that says a vacancy reopens the campaign needs a new rules version (AC-08) before the in-app draw applies to it. The client's draft texts live in its private pack notes, which the public copy leaves out (ADR 0021).

### 9. API contract
All under the admin campaign routes, permission `campaigns.operate` (the one that records the Quiniela draw and the awards), tenant-scoped (`withTenant`). Coupon numbers are strings zero-padded to `entryDigits`.

- `GET /admin/campaigns/:id/app-draw/preview` computes the draw's inputs and writes nothing. It answers `{ campaign: { id, title, round, entryDigits, timezone }, vacant: [{ prizeId, prizeTitle, slot, alternatesCount }], candidates: [{ entryNumber, maskedName }], candidateCount, candidateSha256 }`.
- `POST /admin/campaigns/:id/app-draw` runs the draw: `201` the first time, then `200` with the same body. It answers `{ campaign, round, drawnAt, candidateCount, candidateSha256, picks: [{ prizeId, prizeTitle, slot, role, rank, entryNumber, maskedName }], candidates: [{ entryNumber, maskedName }] }`.
- `GET /admin/campaigns/:id/app-draw` answers the stored result of the current round, with the same body.
- The awards board (`GET /admin/campaigns/:id/awards`) and the campaign detail carry `appDraw: { state: "ready" | "drawn" | "unavailable", round, drawnAt, reason, candidateCount }`. `candidateCount` is counted in the database (eligible coupons with no award) while `ready`, 0 for `no_candidates`, the stored draw's once `drawn`, else null: neither builds nor masks the candidate list (T13). Only the preview, the run and the stored result list every candidate. Each board award carries `source`.
- Each board unit carries `state` (`void` once declared), `canDeclareVoid` and `void: { reason, declaredAt } | null`. `POST /admin/campaigns/:id/awards/:prizeId/slots/:slot/void` with `{ reason }` declares it and answers the board.
- The public transparency (`GET /public/campaigns/:slug/transparency`) carries `appDraws: [{ round, drawnAt, candidateCount, candidateSha256, picks }]` (no inline candidates) and `voidSlots: [{ round, prize, slot, reason, declaredAt }]`; `GET /public/campaigns/:slug/app-draws/:round/candidates.txt` is the candidate list (§6).
- Refusals (`409` unless noted):

| Code | When | Message |
| --- | --- | --- |
| `not_awarding` | campaign not `awarding` | "Las adjudicaciones se registran con la campaña en adjudicación, después de publicar el manifiesto" |
| `quiniela_draw_required` | no Quiniela draw for the round | "Primero registrá el resultado de la Quiniela de esta ronda" |
| `no_vacant_prizes` | nothing vacant | "No hay premios vacantes para sortear en la aplicación" |
| `no_candidates` | every coupon holds an award | "No quedan cupones sin premio para sortear los premios vacantes" |
| `app_draw_exists` | preview after the draw | "Los premios vacantes de esta ronda ya se sortearon en la aplicación" |
| `app_draw_missing` (`404`) | result before the draw | "Los premios vacantes de esta ronda todavía no se sortearon en la aplicación" |
| `reason_required` (`400`) | void without a reason of 5+ characters | "Explicá por qué la unidad queda desierta" |
| `app_draw_possible` | void while the in-app draw can still fill it | "Todavía hay cupones sin premio: sorteá la unidad en la aplicación antes de declararla desierta" |
| `slot_not_voidable` | void of a unit someone holds, or not vacant yet | "Solo se declara desierta una unidad vacante sin cupones para sortear o una sin suplentes disponibles" |
| `slot_already_void` | void twice | "Esta unidad ya fue declarada desierta" |
| `manual_results_open` | void of a vacant unit while a manual result can still be corrected | "Hay resultados cargados a mano que todavía se pueden corregir: decidí sobre sus ganadores antes de declarar desierta una unidad vacante" |

## Alternatives considered

- **A seed from the round's Quiniela extracts (this ADR's proposed version).** A published, deterministic algorithm would apply SHA-256 rejection sampling to the official extracts, so anyone could recompute the result. It was set aside because the owner asked for a random, interactive draw run in the application (S10) and deferred legal precision (S11). Nothing here prevents adding it later as another versioned source.
- **A public randomness beacon (drand).** Set aside for the same reasons, plus an external dependency whose acceptance by the authority is unknown.
- **Reopening (ADR 0014 §5).** Kept only for campaigns already reopened.

## Consequences

- **Winners on the night.** Winners are known the night of the draw, even with few coupons sold. Sales close once.
- **What the platform's randomness means.** Unlike the Quiniela match, the in-app result is not a function of public data: the platform supplies the randomness.
  - The SHA-256 is stored together with the picks, so it proves the published candidate list was not changed afterwards; it is not a commitment made before drawing.
  - Trust rests on the append-only record, the audit trail and the live presentation.
  - The bases must say so before launch (§8).
- **Rounds stay.** Rounds stay in the code for campaigns already reopened and for history.
- **At scale (T13).** The board and the campaign detail cost a few counts whatever the number of coupons; the draw screen still loads every candidate, which the presentation needs; the public page stays small and the list is one cacheable file.

## Open points

- **No candidate left** (closed by T13). The unit is declared void with a public reason (§7) and the campaign can finish. The bases must still say what happens to the prize (kept by the organization, or another destination the authority requires), deferred with S11.
- **Late vacancies** (closed by T13). A unit whose winner and every alternate were declined or voided stays `exhausted` and is not drawn again; it can be declared void with its reason, like a vacancy with no coupon left.
- **Legal review** (deferred with S11). Whether the authority or a notary has to approve this mechanism for each campaign.
