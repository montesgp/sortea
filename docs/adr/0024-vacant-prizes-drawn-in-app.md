# ADR 0024: Vacant prizes are drawn in the application, without reopening sales

Status: accepted, 2026-11-12 (odd/tasks/owner-feedback-2026-11-11b.md, T9; S5, S10, S11; L2, L14). The decisions in L14 are the owner-revisable defaults this ADR records. It amends ADR 0014 §5 for the back office: a vacancy is drawn in the application instead of reopening the campaign. It amends ADR 0003 "Selection" for vacant units only. The legal approval still gates opening (AC-12, ADR 0015), and this ADR records no approval.

Amended 2026-11-12 for campaigns with thousands of coupons (T13; S12, L18): the board counts instead of listing, transparency publishes the candidate list as a file, and a unit nobody can win any more is declared void (§2, §6, §7, §9; the first two open points are closed).

Amended 2026-11-13 for the draw room (odd/tasks/draw-room.md T3; S4, S5 "Sin suplentes", L4): the operator draws **one unit per tirada**, picking which one; the app never draws alternates; a unit whose winner was declined or voided with no alternate left is drawn again. The one-shot run of every vacancy is no longer drawn; a stored one stays readable (§1, §3, §4, §6, §7, §9; the late-vacancy open point is closed). The draw room (T5) replaces the presentation screen (§5).

Amended 2026-11-14 by [ADR 0026](0026-drand-backed-in-app-draw.md) (odd/tasks/draw-room.md T8; S6-S8, L7): a prize can have the mechanism `app`, drawn whole in the application with one tirada per prize, its winners derived from a committed drand quicknet round instead of `crypto.randomInt`, with no Quiniela. This ADR keeps governing `quiniela` prizes (their vacancies and passed-over units, drawn one unit per tirada); for `app` prizes, ADR 0026 replaces §1, §3, §4, §6 and §9, while §2 (candidates), §5 (the draw room and masked names) and §7 (void units and finishing) apply to them too: a pending `app` unit counts as a vacant one.

## Context

ADR 0014 §5 handles a vacant prize by reopening the campaign: sales resume, a new round closes with a new manifest, and a later Quiniela draw decides only the vacant units. With a 0000–9999 pool and 20 extracts, a unit goes vacant whenever few coupons were sold: 300 coupons give an expected 0.6 matches. Reopening would then be the normal outcome, and winners would wait weeks.

The owner's notes, verbatim:
- S5: "El sorteo no se reabre, se sortea por aplicación".
- S10: on the closing day, during the official broadcast, the main prize waits for the number "a la cabeza"; "si no sale lo tiramos dentro de la propia app contra todos los datos y numeros existentes reales, debe ser un random y debe ser interactivo", showing every coupon spinning past "con nombres de las personas cortados", so anyone who pauses the screen can see their number took part.
- S11: "Por ahora no te preocupes por los datos estrictos y legales de las campanias porque aun no estamos productivos."

## Decision

### 1. When
- The in-app draw covers the **drawable units** (`appDrawableUnits`, `packages/domain/src/app-draw.ts`): units of `quiniela` prizes, not declared void, that either
  - the round's Quiniela draw left without a winner (`vacant`, as `vacantQuinielaSlots`, ADR 0014 §5), or
  - had every recorded person (winner and alternates) declined or voided (`exhausted`; amendment 2026-11-13, S5: the prize is drawn again rather than handed to an alternate).
- It runs once the round's Quiniela draw is recorded, while the campaign is `awarding`. It may run before or after the round's results are published.
- **One tirada, one unit** (amendment 2026-11-13). The operator picks the unit; the tirada draws exactly one winner for it. A round has as many tiradas as drawable units, drawn in whatever order the operator picks, and a unit drawn again gets another tirada with the next attempt number.
- A unit that has a winner is never drawn: repeating the request is refused (`unit_has_winner`), so a retry never draws twice.
- **The one-shot run** (every vacancy at once, with alternates; this ADR before the amendment) no longer draws: `POST /admin/campaigns/:id/app-draw` answers a stored one (200) and refuses a new one (`409 app_draw_per_unit`). Stored one-shot draws stay valid, replayable and public, and units they did not fill are drawn per unit.
- Until then, the campaign detail tells whoever can operate it where the draw is and when it opens ("Se habilita acá después del cierre, cuando cargues el resultado de la Quiniela y algún premio quede sin cupón ganador."), and while awarding it shows why it is not offered (owner feedback 2026-11-12 S8).

### 2. Candidates
- The candidates are every coupon of the campaign with status `eligible` that holds no award in any role (winner or alternate) and any round.
- They are the coupons already sold: no sales reopen and no coupon is added. A coupon voided after the close (a refund) is not a candidate.
- **Canonical list.** The coupon numbers ascending, zero-padded to the campaign's digits, one per line, `\n` line endings and no final newline (`appDrawCandidateText`). Its SHA-256 and the count are stored and published, and the text itself is the public download of §6, so `sha256sum <slug>-cupones-sorteo-app-ronda-1.txt` prints the published hash.

### 3. Randomness and order
- The API draws with Node's `crypto.randomInt`, a cryptographically secure generator whose output is uniform over `[0, n)`: one index into the candidates sorted ascending (`drawAppUnit`, `packages/domain/src/app-draw.ts`).
- **No alternates** (amendment 2026-11-13, S5). A tirada gives its unit one winner and nothing else, whatever the prize's `alternatesCount` (which may be 0). Alternates only ever come from the Quiniela match (ADR 0014 §4).
- **Order.** The operator decides which unit is drawn next. The drawable units are listed in prize order (ADR 0014 §4: position, creation, id), then unit order.
- Each candidate has the same chance: one coupon is one chance, as everywhere else (ADR 0014 Consequences).
- The one-shot run drew winners first in prize order, then alternates (`drawVacantSlots`); that function stays for reading what it describes, and no route calls it.

### 4. Recorded before it is shown
One transaction per tirada, under the campaign row lock, before the API answers and before any screen shows anything:
- one append-only `app_unit_draws` row (migration 0026, `0026_draw_room_units`): the round, its `sequence` in the round (1, 2, …), the prize and unit, the unit's `attempt` (1, then 2 when it is drawn again), the candidates, their SHA-256 and count, the coupon drawn, the time and who ran it. Tenant policy and `forbid_mutation` trigger like `app_draws`; unique `(campaign_id, round, sequence)` and `(prize_id, slot, attempt)`, and a check that the pick is one of the candidates;
- the winner's `prize_awards` row, written by the same function as a Quiniela match (`insertSlotAwards`) with `app_unit_draw_id` pointing to the tirada and the note "Sorteo en la app". A unit drawn again keeps the winners passed over before it: the new one is a winner with the next rank, so the slot's history stays and the decision and delivery flow continues unchanged;
- a public log entry (`draw_events`, kind `app_draw`): "Sorteo en la app: Moto" ("…: $100.000, unidad 2" for a prize with several units, "(ronda N)" from round 2), with the candidate count and hash;
- the audit entry `award.app_unit_drawn` (target the prize) with the round, sequence, unit, attempt, count, hash and the coupon drawn, never personal data.

The campaign row lock serializes simultaneous tiradas: the second request for a unit finds its winner and is refused; the attempt index backs it up. The draw room only reveals a decided result, and a reload replays the same tirada.

The one-shot run's records (`app_draws`, migration 0024, one per round, audit `award.app_draw_recorded`) stay as they are.

### 5. The draw room (amended 2026-11-13, odd/tasks/draw-room.md T5)
The back office's one-shot presentation screen (`/admin/campanas/:id/sorteo-app`) is replaced by the **draw room**, `/admin/sala-de-sorteo/:id`; the old address redirects there (308). The room is the landing page of the `draw_host` role and is reached by operators from the campaign detail and "Premios y entregas". A draw host sees no other section: its panel shows the organization, the campaign, "Mi cuenta" and "Salir", and any other panel page answers "No tenés acceso" with the way back to the room (the API refuses it anyway, PRD §4).
- **Header.** The campaign's title and subtitle, the prizes (image, title, units), the award order in words ("Se adjudica del último premio al primero"), the eligible coupons, the manifest SHA-256 (short, with copy) and the round.
- **Live Quiniela** (L1, "Se confirma al final"). Before the round's Quiniela is recorded, 20 numbered positions (1.º to 20.º), each a 4-digit numeric field that moves on after 4 digits or Enter. Every change previews the complete numbers from the 1st on (`POST /admin/campaigns/:id/quiniela/preview` with 1 to 20 extracts and nothing else; no digest), so each position says at once whether it matched and which unit it took, in the campaign's award order, and the winners table grows. Numbers can be corrected until the 20 are confirmed together: "Confirmar los 20 números" previews the whole draw (source, official date and time in the campaign time zone, evidence URL) and, after a confirmation step, records it with that preview's digest. The draft (numbers, source, date, time, evidence) is kept in the browser per campaign and round and cleared once recorded.
- **Winners table.** Every unit in award order: the holder (coupon in full, the consented public name or the masked one, as the API sends them) or its state ("Por definir", "Vacante", "Se carga a mano"). "Sortear esta posición" appears only on the units the API lists as drawable.
- **A tirada.** The operator picks a unit, confirms, and the API draws and stores it (§4) before the reel shows anything: every candidate spins through the centre with its coupon number and masked name, slows down and stops on the stored pick, with a winner animation; the row then fills in from the API. "Registro de tiradas" lists each one with its time, unit, candidate count and short SHA-256, and replays it. A reload shows the same state from the API.
- **Coupon lookup.** The live lookup (S7): a number tells whether it took part and which prize it won; the holder is named only as `winner_publicity` allows.
- **Broadcast mode** ("Modo transmisión", full screen, the dark stage). The campaign, the prizes, the 20 positions, the winners table and the reel; no emails, account, menus, links or URLs, no draw data fields and no hash in full. The inputs to type the numbers and "Sortear esta posición" stay, discreet. Readable at 1280×720 and usable at 390×844.
- Sound comes from the Web Audio API (no audio files) and can be muted. With reduced motion, the screen shows the result without spinning.
- **Masked names.** The first two letters of the buyer's first name, `***` and the initial of the last name: "Ju*** P." (`maskHolderName`). The coupon number is shown in full.

### 6. Public data
- **Transparency.** The transparency page lists each tirada next to the Quiniela draw: time, unit, attempt and candidate count, at once. The coupon drawn, the SHA-256 and the candidate file are published with that round's results, like any award: each tirada's list is the previous one minus its pick, so a list or its hash would reveal the earlier picks (native review finding R1-tirada-pick-leak, 2026-11-14). The public log entry of a tirada says only the count. A stored one-shot draw is listed as before (time, count, SHA-256; its picks with the results).
- **One file per tirada** (amendment 2026-11-13). Each tirada's candidate list is `GET /public/campaigns/:slug/app-draws/:round/units/:sequence/candidates.txt`, with the same format, headers and cache as below, named `<slug>-cupones-sorteo-app-ronda-<round>-tirada-<sequence>.txt`, answers 404 until the round's results are published. The site serves it at `/sorteos/:slug/sorteo-app/:round/unidades/:sequence/cupones.txt`, byte for byte like the one-shot route below, and the transparency page lists each tirada with its download.
- **Candidate list as a file (T13).** The candidate coupon numbers (numbers only) are not inlined in the page or its JSON, since a campaign can have thousands. The page links "Descargar la lista de cupones (.txt)" to the site's `/sorteos/:slug/sorteo-app/:round/cupones.txt`, which passes through `GET /public/campaigns/:slug/app-draws/:round/candidates.txt` byte for byte: the canonical text of §2, `text/plain; charset=utf-8`, the hash in `x-content-sha256`, cacheable (`public, max-age=3600`) because the record is append-only. It is tenant-scoped like the other public routes and answers 404 for a campaign that is not public or a round without an in-app draw. The page shows the commands to check it: `sha256sum <file>` (Linux), `shasum -a 256 <file>` (macOS), `Get-FileHash <file>` (Windows PowerShell).
- **Void units.** A unit declared void (§7) is listed as "Desierto" with its reason once the results of the round it was declared in are published, and no longer as vacant.
- **Winners.** The winners section and the transparency awards carry `source: "app_draw"`, which the site labels "Sorteo en la app". Names follow `winner_publicity` exactly as for any winner (SECURITY.md).

### 7. Reopening
- The back office no longer offers reopening (L14); the in-app draw is the vacancy path.
- `POST /admin/campaigns/:id/reopen` keeps working, unchanged, for campaigns already reopened and for data repair. A campaign that is still in a later round keeps the rounds of ADR 0014 §5.
- A campaign with a vacant unit still cannot reach `fulfilled`. The refusal (`prizes_vacant`) names the way forward: "Hay premios vacantes: sortealos en la aplicación" while a coupon without a prize is left, and "Hay premios vacantes sin cupones para sortear: declaralos desiertos con «Declarar desierto» en Premios y entregas" once none is.
- **Declaring a unit void (T13).** From the awards page, "Declarar desierto" with a required reason (5 to 1000 characters), permission `campaigns.operate`, while the campaign is awarding. It applies to a vacant unit only when no coupon without a prize is left (fewer coupons than vacant units, typically after the in-app draw used them all), counted at the moment of the request, and only once every manual result is settled: while a result typed in by hand still holds awards and can be corrected (`canRecordSlot`: nobody in it decided, results not published), a correction could give its coupons back to the in-app draw, so the declaration is refused (`manual_results_open`) and the awards page says why. With every manual result frozen, the count of coupons left can only go down, so a void declared at zero stays justified. It also applies to an `exhausted` unit, whose winner and every alternate were declined or voided: at once for a `manual` prize, and for a `quiniela` prize under the same rule as a vacancy (amendment 2026-11-13: the in-app draw gives it a new winner first). While the in-app draw can still give a unit a winner it is refused, so a unit is never left void by choice. The rule is `canDeclareSlotVoid` (`packages/domain/src/awards.ts`, with `appDrawable`).
- **Finishing.** A drawable unit, vacant or exhausted, keeps the campaign from `fulfilled` (`prizes_vacant`) until it is drawn or declared void.
  - It is recorded append-only, one per unit, in `prize_slot_voids` (migration 0025, tenant policy and `forbid_mutation` trigger), with the round, the reason, who and when, and audited as `award.slot_declared_void` (unit, round, previous state, reason).
  - The unit then counts as resolved, in every round: `vacantQuinielaSlots` (`packages/domain/src/quiniela.ts`) is the one definition of an open unit and leaves void units out, so the Quiniela match of a later round, the in-app draw, reopening and the public "Premios vacantes que se sortean en esta ronda" never include it. It is no longer vacant and does not block `fulfilled` (nor, after it, archiving). What happens to the prize itself (kept by the organization or another destination) is for the bases (§8).

### 8. Legal texts deferred (S11)
- The platform is in production but not launched. Following S11, this ADR does not add a vacancy policy per rule version, nor bases texts or announcements.
- Before launch, each campaign's bases must describe this mechanism. A bases text that says a vacancy reopens the campaign needs a new rules version (AC-08) before the in-app draw applies to it. The client's draft texts live in its private pack notes, which the public copy leaves out (ADR 0021).

### 9. API contract
All under the admin campaign routes, permission `campaigns.operate` (the one that records the Quiniela draw and the awards), tenant-scoped (`withTenant`). Coupon numbers are strings zero-padded to `entryDigits`.

- `GET /admin/campaigns/:id/app-draw/preview` computes the next tirada's inputs and writes nothing; it is usable before each tirada. It answers `{ campaign: { id, title, round, entryDigits, timezone }, vacant: [{ prizeId, prizeTitle, slot, alternatesCount }], candidates: [{ entryNumber, maskedName }], candidateCount, candidateSha256 }`, where `vacant` lists the drawable units.
- `POST /admin/campaigns/:id/app-draw/units` with `{ prizeId, slot }` runs one tirada and answers `201` with `{ campaign, round, sequence, attempt, prizeId, prizeTitle, slot, drawnAt, candidateCount, candidateSha256, pick: { entryNumber, maskedName }, candidates: [{ entryNumber, maskedName }] }`.
- `GET /admin/campaigns/:id/app-draw/units` answers `{ campaign, tiradas: […the same without campaign and candidates], units: [{ prizeId, prizeTitle, slot, state: "vacant" | "exhausted" }], candidateCount, reason }`: the round's tiradas in order (the winners table and replays), the units that can be drawn now, the coupons in play counted (0 when none is left, null when nothing can be drawn for another reason) and why nothing can be drawn, else null.
- `GET /admin/campaigns/:id/app-draw/units/:sequence` replays one of the round's tiradas with its candidates, for the reel.
- `POST /admin/campaigns/:id/app-draw` (one-shot) answers a stored draw with `200` and `{ campaign, round, drawnAt, candidateCount, candidateSha256, picks: [{ prizeId, prizeTitle, slot, role, rank, entryNumber, maskedName }], candidates }`, and refuses to draw a new one. `GET /admin/campaigns/:id/app-draw` answers the stored one-shot draw of the current round, with the same body.
- The awards board (`GET /admin/campaigns/:id/awards`) and the campaign detail carry `appDraw: { state: "ready" | "drawn" | "unavailable", round, drawnAt, reason, candidateCount }`: `ready` while a unit can be drawn (`candidateCount` counted in the database, `drawnAt` the round's latest tirada or null); `drawn` when nothing can be drawn now and the round has a tirada or a stored one-shot draw (the latest one's time and count); else `unavailable` with the reason (`candidateCount` 0 for `no_candidates`, else null). Neither builds nor masks the candidate list (T13). Only the preview, a tirada and the replays list every candidate. Each board award carries `source`.
- Each board unit carries `state` (`void` once declared), `canDeclareVoid` and `void: { reason, declaredAt } | null`. `POST /admin/campaigns/:id/awards/:prizeId/slots/:slot/void` with `{ reason }` declares it and answers the board.
- The public transparency (`GET /public/campaigns/:slug/transparency`) carries `appUnitDraws: [{ round, sequence, prize, slot, attempt, drawnAt, candidateCount, candidateSha256, entryNumber }]` (`candidateSha256` and `entryNumber` null until the round's results are published), `appDraws: [{ round, drawnAt, candidateCount, candidateSha256, picks }]` for stored one-shot draws (no inline candidates) and `voidSlots: [{ round, prize, slot, reason, declaredAt }]`; `GET /public/campaigns/:slug/app-draws/:round/units/:sequence/candidates.txt` is a tirada's candidate list and `GET /public/campaigns/:slug/app-draws/:round/candidates.txt` a one-shot draw's (§6).
- Refusals (`409` unless noted):

| Code | When | Message |
| --- | --- | --- |
| `not_awarding` | campaign not `awarding` | "Las adjudicaciones se registran con la campaña en adjudicación, después de publicar el manifiesto" |
| `quiniela_draw_required` | no Quiniela draw for the round | "Primero registrá el resultado de la Quiniela de esta ronda" |
| `no_vacant_prizes` | nothing drawable (preview) | "No hay premios vacantes para sortear en la aplicación" |
| `no_candidates` | every coupon holds an award | "No quedan cupones sin premio para sortear los premios vacantes" |
| `invalid_slot` (`400`) | a unit the prize does not have | "Ese premio no tiene tantas unidades" |
| `not_found` (`404`) | a prize of another campaign or organization, or an unknown tirada | "Premio no encontrado", "Sorteo en la app no encontrado" |
| `unit_not_drawable` | a tirada for a `manual` prize | "Este premio se carga a mano: no se sortea en la aplicación" |
| `unit_has_winner` | a tirada for a unit someone holds, including a repeated request | "Esta unidad ya tiene ganador: no se vuelve a sortear" |
| `slot_void` | a tirada for a unit declared void | "Esta unidad fue declarada desierta: no se sortea" |
| `app_draw_per_unit` | a new one-shot run | "El sorteo en la app ahora se hace premio por premio: elegí la unidad que vas a sortear" |
| `app_draw_missing` (`404`) | one-shot result when none is stored | "Los premios vacantes de esta ronda todavía no se sortearon en la aplicación" |
| `reason_required` (`400`) | void without a reason of 5+ characters | "Explicá por qué la unidad queda desierta" |
| `app_draw_possible` | void while the in-app draw can still fill it (vacant, or a Quiniela unit out of alternates) | "Todavía hay cupones sin premio: sorteá la unidad en la aplicación antes de declararla desierta" |
| `slot_not_voidable` | void of a unit someone holds, or not vacant yet | "Solo se declara desierta una unidad vacante sin cupones para sortear o una sin suplentes disponibles" |
| `slot_already_void` | void twice | "Esta unidad ya fue declarada desierta" |
| `manual_results_open` | void of a vacant unit while a manual result can still be corrected | "Hay resultados cargados a mano que todavía se pueden corregir: decidí sobre sus ganadores antes de declarar desierta una unidad vacante" |

## Alternatives considered

- **A seed from the round's Quiniela extracts (this ADR's proposed version).** A published, deterministic algorithm would apply SHA-256 rejection sampling to the official extracts, so anyone could recompute the result. It was set aside because the owner asked for a random, interactive draw run in the application (S10) and deferred legal precision (S11). Nothing here prevents adding it later as another versioned source.
- **A public randomness beacon (drand).** Set aside for the same reasons, plus an external dependency whose acceptance by the authority is unknown. Adopted on 2026-11-14 for `app` prizes (ADR 0026), when the owner chose to draw every prize in the application (S6, S8).
- **Reopening (ADR 0014 §5).** Kept only for campaigns already reopened.

## Consequences

- **Winners on the night.** Winners are known the night of the draw, even with few coupons sold. Sales close once.
- **Per unit** (amendment 2026-11-13). Each tirada is its own record, file and log entry, so a broadcast can draw the missing units one by one and the winners table grows with each. A unit's history keeps every winner passed over.
- **What the platform's randomness means.** Unlike the Quiniela match, the in-app result is not a function of public data: the platform supplies the randomness.
  - The SHA-256 is stored together with the picks, so it proves the published candidate list was not changed afterwards; it is not a commitment made before drawing.
  - Trust rests on the append-only record, the audit trail and the live presentation.
  - The bases must say so before launch (§8).
- **Rounds stay.** Rounds stay in the code for campaigns already reopened and for history.
- **At scale (T13).** The board and the campaign detail cost a few counts whatever the number of coupons; the draw screen still loads every candidate, which the presentation needs; the public page stays small and the list is one cacheable file.

## Open points

- **No candidate left** (closed by T13). The unit is declared void with a public reason (§7) and the campaign can finish. The bases must still say what happens to the prize (kept by the organization, or another destination the authority requires), deferred with S11.
- **Late vacancies** (closed by T13, reversed 2026-11-13 by S5). A Quiniela unit whose winner and every alternate were declined or voided is drawn again in the app, with a new tirada; it is declared void only when no coupon without a prize is left, like a vacancy. A manual unit in that state can still be declared void at once.
- **Legal review** (deferred with S11). Whether the authority or a notary has to approve this mechanism for each campaign.
