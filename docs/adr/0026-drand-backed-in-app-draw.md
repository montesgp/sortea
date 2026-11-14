# ADR 0026: Prizes drawn in the application from the drand beacon, one tirada per prize

Status: accepted, 2026-11-14 (odd/tasks/draw-room.md T8; S6, S7, S8; L6, L7). It adds a prize mechanism, `app`, next to ADR 0014's `quiniela` and `manual`, and amends ADR 0024 for those prizes: their winners come from a public randomness beacon instead of the server's random number. Quiniela prizes and their per-unit tiradas (ADR 0024) stay as they are. The legal approval still gates opening (AC-12, ADR 0015), and this ADR records no approval.

## Context

The owner, verbatim:
- S6: "Si pero no habria problema con la confianza ya que somos open-source, quiere decir que el codigo puede ser visible y leerse para detectar que el algoritmo es un random sin sesgo alguno. Asi que vamos por ese lado, simplifiquemos la plataforma. Olvidemos el ingreso de momento de la quinela y hagamos mas simple el sorteo. Se hace una sola tirada por cada premio. Si el premio 3 son 5 premios encuentra 5 numneros ganadores y asi con todo."
- S7: app-sorteos.com, if it offered a free public API to certify the draw.
- S8: "Si el A hace que seamos rapido y no somos propenso a errores el dia del roteo buscamos A. A nos permite que esos numeros puedan ser del 0000 al 9999 por ejemplo?"

What the evidence showed (L7):
- app-sorteos.com documents no public API to submit a list and get winners, charges for list draws above 300 entries, and its certificate is a page hosted by the vendor with no list hash or seed: nobody can re-run a result.
- With the server's `crypto.randomInt` (ADR 0024 §3), open source shows the algorithm but not the number the server drew: the published hash proves the list did not change after the draw, not that the draw was fair.
- drand (League of Entropy) publishes, on its quicknet chain, a BLS-signed random value every 3 seconds since 2023-08-23. Nobody, the platform included, knows a round's value before the threshold of operators signs it, and anyone can verify the signature with the chain's public key.

## Decision

### 1. Mechanism
- A prize has `mechanism` `app` (migration 0028, `0028_app_prize_mechanism`, which only adds the enum value): it is drawn in the application, with no Quiniela. Prize creation and editing accept it (`prizeInputSchema`), and so do client packs.
- Coupons stay numbered 0000-9999 (ADR 0014 §1). The beacon chooses among the coupons actually sold, so a tirada always has winners while a coupon is left.
- **One tirada per prize** (S6). A tirada gives a winner to every unit of the prize that is still pending: with a prize of 5 units, one tirada draws 5 winners, the first for unit 1. Prizes are drawn in whatever order the operator clicks; the draw room lists them in the campaign's award order (ADR 0014 §4).
- **Candidates**, as in ADR 0024 §2: every coupon of the campaign with status `eligible` that holds no award in any role and round, ascending. Its canonical text (`appDrawCandidateText`) and SHA-256 are what get published.
- **Pending units**: units not declared void that nobody holds, or whose every recorded person declined or was voided (`appPrizePendingUnits`). A unit whose winner is declined or voided becomes pending again, and the prize's next tirada (attempt 2, 3…) draws only those units. The app never draws alternates (S5).

### 2. The beacon
- Chain: quicknet, hash `52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971`, genesis 1692803367 (Unix seconds), period 3 s, scheme `bls-unchained-g1-rfc9380` (`packages/domain/src/drand.ts`).
- Round `r` is published at `genesis + (r − 1) × 3` seconds. The round a tirada commits to is `commitDrandRound(now)`: the first one published at least one second after the commitment (`DRAND_COMMIT_MARGIN_MS`), so the commitment is stored before its round exists even when the click lands in the last milliseconds before a round.
- The API reads a round from the relays in order: `https://api.drand.sh`, `https://api2.drand.sh`, `https://api3.drand.sh`, `https://drand.cloudflare.com` (`DRAND_RELAYS`, comma-separated, replaces them), at `/<chain hash>/public/<round>`, with 2 s per relay (`apps/api/src/lib/drand.ts`).
- A relay is a cache, not a source of trust. A round is accepted only when its BLS signature verifies against the chain's public key for that round (the message is SHA-256 of the round as 8 bytes big-endian, hashed to G1 with `BLS_SIG_BLS12381G1_XMD:SHA-256_SSWU_RO_NUL_`) and its randomness equals SHA-256 of the signature. The verification uses `@noble/curves` 2.4.0 (MIT, audited, one dependency, pinned exactly), chosen over the `drand-client` package, which also brings a fetch polyfill, a Buffer polyfill and a BN254 library the API does not need.
- A relay answering "Requested future beacon" (HTTP 425; 404 on Cloudflare's) means the round is not out yet; that relay is skipped like one that is down or answers a beacon that does not verify.

### 3. Algorithm (`drawFromBeacon`, `packages/domain/src/server/drand-draw.ts`)

```
remaining = candidates, ascending
for i = 0, 1, 2, …
  h = SHA-256(utf8("<randomness>:<candidateSha256>:<i>")) as a 256-bit unsigned integer
  n = remaining.length
  if h ≥ floor(2^256 / n) × n: reject h, continue with i + 1
  else: pick remaining[h mod n] and remove it
until `count` picks (the tirada's units) or nothing remains
```

`randomness` and `candidateSha256` are the lowercase hex strings that get published. Rejection sampling makes every remaining coupon equally likely at every step, with no modulo bias. A rejection has probability below `n / 2^256`, but it is part of the rule. The picks are in drawing order: pick 1 goes to the tirada's first unit. Test vector: quicknet round 1000000 (randomness `b22aad47…0af3`) over coupons 0000-0009 (SHA-256 `5e8d38ac…1df1`) gives 0002, 0005, 0004 (`packages/domain/test/drand-draw.test.ts`, `scripts/verify-app-draw.test.mjs`).

### 4. Commit, then reveal
`POST /admin/campaigns/:id/app-draw/prizes/:prizeId` (permission `campaigns.operate` or `draws.run`, `withTenant`):
1. **Commit**, in one transaction under the campaign row lock: the campaign is `awarding`, the round's manifest is published, the prize is `app`, it has pending units, and a coupon is left. One append-only `app_prize_draws` row (migration 0029, `0029_app_prize_draws`): the campaign round, its `sequence` in the round, the prize, its `attempt`, the units (ascending), the chain and the drand round, the candidates, their SHA-256 and count, who and when. Unique `(prize_id, attempt)` and `(campaign_id, round, sequence)`. Audit `award.app_draw_committed`; public log "Sorteo en la app comprometido: <premio>" with the drand round and the candidate count. No hash and no list: they go public with the round's results (R1-tirada-pick-leak, ADR 0024 §6).
2. **Wait and read**, outside any transaction: until the round's publication time (plus 300 ms), then up to 4 reads 1 s apart within 15 s.
3. **Reveal**, in a second transaction under the lock, if the commitment has no reveal yet: one append-only `app_prize_draw_reveals` row with the drand round, signature, randomness and picks (unit and coupon, in order). A composite key ties it to the committed drand round, and a unique index allows one reveal per commitment. One winner award per pick goes through `insertSlotAwards` (`app_prize_draw_id`, note "Sorteo en la app (drand <round>)"; a unit drawn again keeps the winners passed over, ranked first). Audit `award.app_draw_revealed` (randomness and picks, never personal data); public log "Sorteo en la app: <premio>" with the units filled.

The answer is `201` with the tirada (prize, units, drand round and its time, candidate count, SHA-256, beacon with the relay URL, picks with masked names, candidates for the reel), `200` when another request revealed it first, and `202` with the committed tirada and no picks when the round could not be read in time. Both tables carry `organization_id`, the tenant policy and the `forbid_mutation` trigger.

### 5. Failure handling
- **Beacon unavailable or late.** The tirada stays committed (`202`). The next "Sortear" on that prize resumes it: it reads the **same** round, never a new one, and reveals it. Choosing another round after seeing one would let the platform pick among results; resuming never re-commits.
- **One tirada pending per campaign.** While a tirada waits, its candidate list is fixed. A tirada of another prize (`409 app_draw_pending`), a manual result, the Quiniela record, a per-unit tirada and a void declaration are refused until it is revealed, so the reveal can always award what the committed list gives: "Hay una tirada de «<premio>» esperando su ronda de drand: terminala con «Sortear» antes de seguir".
- **Simultaneous clicks.** The campaign row lock orders them: the second one finds the first one's commitment and resumes it, and the reveal is written once.
- **Fewer coupons than units.** The tirada fills what it can. With no coupon left, `409 no_candidates` ("No quedan cupones sin premio para sortear este premio"), and the remaining units are declared void as vacancies (ADR 0024 §7).
- **Refusals** change nothing: `not_awarding`, `manifest_required` ("Falta el manifiesto publicado"), `not_app_prize` ("Este premio no se sortea en la aplicación: se carga a mano o sale de la Quiniela"), `no_pending_units` ("Todas las unidades de este premio ya tienen ganador: no hay nada para sortear"), `no_candidates`, `app_draw_pending`; a prize of another campaign or organization is not found.
- **Finishing.** A pending unit of an `app` prize keeps the campaign from `fulfilled` (`prizes_vacant`) and, with no coupon left, is declared void, exactly as a vacant Quiniela unit.

### 6. Reading and transparency
- `GET /admin/campaigns/:id/app-draw/prizes`: the `app` prizes in the campaign's award order, each with its units (`pending`, `exhausted`, `held`, `void`), its state (`pending`, `committed` while its tirada waits, `drawn` when nothing is left), its tiradas and why it cannot be drawn now; the coupons in play counted; and why nothing can be drawn. The draw room view (`GET /admin/draw-room/campaigns/:id`) carries the same as `appPrizes`, without candidate lists.
- `GET /public/campaigns/:slug/transparency` carries `appPrizeDraws`: per tirada its round, sequence, prize, units, attempt, commitment time, drand round and its time, and candidate count at once; once the round's results are published, also the candidate SHA-256, the beacon (signature, randomness, relay URL of the round) and the picks.
- `GET /public/campaigns/:slug/app-draws/:round/prizes/:sequence/candidates.txt` serves the candidate list (canonical text, `text/plain; charset=utf-8`, hash in `x-content-sha256`, `public, max-age=3600`, named `<slug>-cupones-sorteo-app-ronda-<round>-premio-<sequence>.txt`), with a 404 until the round's results are published.
- `scripts/verify-app-draw.mjs` recomputes the winners with no dependencies: `node scripts/verify-app-draw.mjs --candidates <file.txt> --count <units> --round <drand round>` (or `--randomness <hex>`). It checks that the relay's randomness is SHA-256 of the signature. A drand client checks the signature itself.

### 7. The draw room (draw-room T9)
- With `app` prizes, the room (`/admin/sala-de-sorteo/:id`) lists them in the API's award order, each with its image, units, state ("Pendiente", "Comprometido: esperando el número de drand", "Sorteado") and winners (coupon and the consented public name or the masked one). Each prize has its own "Sortear <premio>"; only the next one in award order is the highlighted action. The 20-position Quiniela entry appears only while the campaign still has `quiniela` prizes.
- "Sortear" asks to confirm how many winners the tirada draws and among how many coupons, then posts once. While the answer is `202` or lost, the screen shows "Esperando el número público de drand (ronda N)…" and posts the same request every 2 s for up to a minute, which resumes the committed round (§5); after that it offers "Reintentar", which does the same and never starts another tirada. A reload with a tirada pending shows the wait and resumes it.
- On `201` or `200` the reel runs through the tirada's candidates and stops once per unit, in drawing order: a long first spin, then a short one per further unit. The "Registro de tiradas" lists each tirada with its prize, units, drand round, time, candidate count and short SHA-256. Broadcast mode keeps the list, the buttons, the wait and the reel, and shows no system data beyond the drand round and the short hash.
- The transparency page has a section "Sorteo en la app con número público (drand)": per tirada, the prize, units, commitment time, drand round and candidate count at once; with the round's results, the winners, the list's SHA-256, the round's randomness with a link to it on the relay, the list download (`/sorteos/:slug/sorteo-app/:round/premios/:sequence/cupones.txt`, passed through from the API) and the `verify-app-draw.mjs` command for each tirada, with what it proves.

## What it proves, and what it does not
- **Proves.** The candidate list and the units were stored before the round existed. The round's randomness is public, signed by the League of Entropy and unknown to anyone before its time. The winners are a fixed public function of both, so anyone can recompute them from the published file and the round. The platform cannot choose the result, and it cannot retry until it likes one: the round is fixed at the commitment, and a failure resumes it.
- **Does not prove** that the candidate list is complete and correct: that rests on the published manifest (ADR 0003, ADR 0014 §1), the coupon lookup and the append-only records. It does not prove that the commitment row was written before the round: the database's own time and the audit trail say so, and the live broadcast shows the click. Nor does it prove which commitment was the first. A platform that committed, saw the round and then deleted the row would break the append-only trigger and the public log entry written with it. The authority's acceptance of this mechanism is a legal question (ADR 0024 §8).

## Alternatives considered
- **Server random (`crypto.randomInt`, ADR 0024).** Unbiased, and the code is public, but nobody can recompute a result: trust rests on the operator. It stays for the per-unit tiradas of Quiniela prizes.
- **app-sorteos.com (S7).** No public API to submit a list, paid above 300 entries, and a vendor-hosted certificate with no hash or seed (L7). Set aside.
- **NIST Randomness Beacon.** A single operator, a one-minute period and a history of outages. drand's threshold network and 3-second period suit a live broadcast better. Set aside.
- **The Quiniela extracts as a seed (ADR 0024, Alternatives).** Ties the draw to the lottery's schedule, which S6 drops for now.

## Consequences
- A tirada takes about 3 seconds plus the read, so it works live on the broadcast, and it never depends on the Quiniela schedule.
- The API reaches out to the drand relays (HTTPS GET only), and the API image adds `@noble/curves`.
- A relay outage delays a tirada but never changes its result.
- Quiniela prizes keep ADR 0014 and ADR 0024. A campaign may mix both, and its bases must describe each prize's mechanism before launch.
