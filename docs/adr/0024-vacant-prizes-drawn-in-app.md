# ADR 0024: Vacant prizes are drawn in the application, without reopening sales

Status: proposed, 2026-11-12 (odd/tasks/owner-feedback-2026-11-11b.md, T9, S5, L2, L5). The owner approves it before any implementation. Once accepted it amends ADR 0014 §5 and the "Selection" bullet of ADR 0003 for rule versions that adopt it, and DRAW-INTEGRITY item 5. The legal approval still gates opening (AC-12, ADR 0015), and this ADR records no approval.

## Context

ADR 0014 §5 handles a vacant prize like this: when the 20 Quiniela extracts leave a `quiniela` slot without a winner, the admin reopens the campaign (`POST /admin/campaigns/:id/reopen`) for a new round with a new closing date. Sales resume, the round closes with a new manifest, and a later Quiniela draw decides only the vacant slots. In code:
- `vacantQuinielaSlots` and `matchQuinielaDraw` (`packages/domain/src/quiniela.ts`);
- `campaigns.current_round`, plus `round` on `draw_manifests`, `draw_events` and `prize_awards` (migration 0012);
- one `quiniela_draws` row per round (migration 0011);
- the reopen action and `prizes_vacant` (`apps/api/src/modules/admin.ts`);
- `quinielaContext` (`apps/api/src/modules/awards.ts`).

With a 0000–9999 pool and 20 extracts, a slot goes vacant whenever few coupons were sold. For example, 300 coupons give an expected 0.6 matches over the 20 extracts. In that case reopening is the normal outcome, not an edge case: the campaign sells again after its announced draw and the winners wait weeks.

The owner's note (S5, verbatim): "El sorteo no se reabre, se sortea por aplicación".

The owner's decision (L2, verbatim): "Si queda vacante, se sortea entre los cupones existentes con el sorteo verificable de la propia plataforma, sin reabrir ventas".

L5: The first client's bases in force ("Premios vacantes") say the campaign reopens. Changing that is a change to the rules of an open campaign, so it needs a new bases version (AC-08) before it applies.

## Requirements this design has to meet

- The candidates are only the coupons already sold: the eligible entries of the round's published manifest. No sales reopen, no new manifest, and no coupon is added or removed.
- The commitment comes before the randomness. The manifest hash, the algorithm and the randomness source are all public before the randomness exists (ADR 0003: the manifest comes before any selection).
- The platform adds no randomness of its own. The randomness comes from a public source that neither the organizer nor the platform can influence. The platform only applies a published, deterministic algorithm to it.
- Anyone can recompute the result from public data with ordinary tools.
- The draw is unbiased: every candidate coupon is equally likely.
- There is exactly one winner per slot, with alternates as in ADR 0014 §4, and one award per coupon (`prize_awards_entry_uq`).

## Options for the randomness source

The algorithm (below) is the same for every option. Only the seed changes.

| | A. The same Quiniela draw that decided the round | B. A later Quiniela draw named in advance | C. drand (League of Entropy), round N |
| --- | --- | --- | --- |
| What it is | The 20 extracts already recorded in `quiniela_draws` for the round seed the vacant draw, which runs right after the matching. | A specific later draw (for example "Quiniela de la Ciudad, Nocturna, the next business day after the main draw"), announced in the public log before it takes place. | A public randomness beacon (quicknet: one threshold-BLS-signed value every 3 s). The round number is computed from a date and time fixed in advance. |
| Transparency for Argentine audits (lottery authority, IPLyC-style, notary's act) | Highest. Every number comes from the official draw the bases already name and the authority or notary already witnesses. One official act covers the whole result. | High. It is an official draw, but a second one, so it needs a second act or evidence and a second announcement. | Unknown. The authority and notaries know the Quiniela, not a foreign cryptographic beacon. It would have to be explained and accepted with the legal approval. |
| Offline reproducibility | Full: the extracts are on the official extract page and in the public log, and SHA-256 is the only tool needed. | Full, the same as A. | Full only for someone who verifies a BLS signature (it needs a library). Anyone else takes the beacon's word for it. |
| Dependency risk | None new. If the official draw is suspended, the bases already have to say what happens (see the open questions). | None new, but the result waits one more draw (Monday to Saturday), and a suspension can delay it too. | An external network and its HTTP API, plus a crypto dependency. If the round is not available, a fallback rule is needed ("the first later round published"). |
| Timing | The same night, live, in the same broadcast. | One or more days later. | Any minute, 24/7. |
| Data entry | None extra (the 20 extracts are already recorded and checked against the evidence). | 20 more numbers typed in, checked against the evidence URL like today. | Fetched and verified by code, with no typing. |
| Explaining it to buyers | "The same extract that decided the prizes also decides the vacant ones." | "Next draw X decides it." | Hard to explain on a stream. |
| Implementation size | Smallest. | A + schedule and record actions. | A + a beacon client and a signature check. |

**Recommendation: option A for the vacancies the draw leaves on the night, and option B only for late vacancies.** A late vacancy is a slot whose winner and every alternate were later declined or voided, for example because the winner turned out to be a minor (bases "Verificación y entrega de premios"). Option C is rejected for now. Its cryptography is better, but its regulatory acceptance in Argentina is unknown and it adds an external dependency, which outweighs that. Nothing in the algorithm prevents adding it later as another seed source.

Why A is sound even though its seed is the same extract:
- The manifest (hash published), the algorithm (in the locked bases) and the source (named in the bases) are all fixed before the draw happens.
- The matching stage is deterministic, so the set of vacant slots and the set of coupons already awarded are a function of the same public data.
- Nobody learns anything useful before the official draw, and after it nothing can be chosen.

The one input the organizer still controls after the draw is a manual award on a coupon (`manual` prizes). ADR 0014 §4 already handles that: the preview digest has to match on confirmation, and both stages are computed and confirmed in one transaction. A coupon that holds a manual award is skipped in the stream as "ya premiado", exactly as an extract is skipped today.

## Decision (proposed)

### 1. Vacancy policy per rule version
- `campaign_rule_versions` gains `vacancy_policy`: `reopen` (ADR 0014 §5) or `in_app_draw` (this ADR).
- The migration adds the column with `reopen` for every existing row, so every locked version keeps exactly the rule its text states. Adding a column does not fire the row-immutability trigger. The column default then becomes `in_app_draw`, so new campaigns get the new rule.
- The policy that applies to a round is the one of the rule version recorded in that round's manifest header (`ruleVersion`), which is the version in force at the close.
- Like `entryRule`, the policy is fixed by the immutability of locked versions. The published `contentHash` still covers the text only (ADR 0003), and the text states the policy. The admin form shows the policy next to the text, and the bases template of the platform documentation states both policies, so the two cannot silently diverge.

### 2. Stage 1 is unchanged
The Quiniela matching of ADR 0014 §3-§4 runs as today. With `in_app_draw`, if it leaves vacant `quiniela` slots, stage 2 runs inside the same preview and the same confirmation.

### 3. Stage 2: the in-app vacant draw (`sortea.vacant-draw.v1`)
Inputs, all public:
- the round's manifest (its bytes and SHA-256);
- the 20 extracts in official order;
- the campaign id and round, which are in the manifest header;
- the prize order of ADR 0014 §4, as shown on the campaign page;
- the coupons that already hold an award, which are public once results are published.

**Candidates.** The eligible entries of the manifest, sorted by coupon number, ascending: `C[0..n−1]`. The list includes coupons that won in stage 1, which are skipped below. That way the list depends on the manifest alone.

**Seed.** The lowercase hex SHA-256 of this UTF-8 text, with `\n` line endings and no final newline:
```
sortea.vacant-draw.v1
campaign:<campaignId>
round:<round>
manifest:<manifest sha256, lowercase hex>
source:<sequence>
extracts:<the 20 extracts, 4 digits each, comma-separated, official order>
```
`sequence` is `0` for the vacant draw of the night (option A) and `1`, `2`, … for supplementary draws (option B). Supplementary draws use their own draw's extracts.

**Stream.** For `k = 0, 1, 2, …`:
- `H_k = SHA-256(UTF-8("<seed>:<k>"))`, read as an unsigned 256-bit big-endian integer `x`.
- With `limit = 2^256 − (2^256 mod n)`: if `x ≥ limit`, step `k` is rejected (outcome `rejected`, probability below n/2^256) and the stream moves on.
- Otherwise `i = x mod n`, and the step names coupon `C[i]`.

Rejection sampling makes every index exactly equally likely. Anyone can reproduce a step with `printf '%s' "<seed>:<k>" | sha256sum` and a big-integer modulo (a spreadsheet, Python, or the verifier below).

**Walking the stream.** This mirrors the extracts:
- A coupon already named earlier in the stream is `repeated`.
- A coupon that holds an award in any role, from any round or from stage 1, is `already_awarded`.
- Otherwise it is a match.
- Matches fill the vacant slots' winners in prize order, then slot order. They then fill the alternates of those same slots, slot by slot, up to the prize's `alternatesCount`. Stage-1 slots keep their stage-1 alternates.
- The walk stops when every seat is filled or when all `n` candidates have appeared. A slot that is still empty then has no candidate left; the open questions cover what happens to it.

**Result and digest.** The preview returns both stages, and the digest of ADR 0014 §4 covers both (the digest payload gains the stage-2 steps). Confirming recomputes both stages and writes the following in one transaction:
- the `quiniela_draws` row;
- one append-only `vacant_draws` row with the seed, the candidate count and every step up to the last one used;
- the `prize_awards` rows;
- a public log entry.

The existing decision and delivery flow is unchanged.

### 4. Late vacancies (option B)
- **The vacancy.** A slot becomes a late vacancy when its winner and every alternate are declined or voided.
- **The announcement.** The admin announces a supplementary draw in the public log. It names an official Quiniela draw (source, date and time) at least 24 hours later, and the coupons that already hold awards at that moment.
- **Recording.** After that draw, the admin records its 20 extracts with the evidence URL, as in ADR 0014 §3. The draw has to be later than the announcement, and in the past.
- **The draw.** Stage 2 runs with `source:<sequence>` against the same round's manifest, for the late-vacant slots only.
- **What it never does.** It never reopens sales and never writes a new manifest.

### 5. No reopening for `in_app_draw`
- `POST /admin/campaigns/:id/reopen` refuses with 409 `vacancy_policy_in_app_draw` when the round's rule version has `in_app_draw`. Campaigns under `reopen` keep the current action and rounds unchanged.
- `current_round` stays at 1 for `in_app_draw` campaigns. Rounds, manifests v2 and `?round=` stay as they are for the `reopen` policy and for history.

### 6. Verification
- Each vacant draw is downloadable from `/public/campaigns/:slug/vacant-draws?round=N` as a JSON document (`sortea.vacant-draw.v1`). It holds the inputs, the seed text, the seed and every step: `k`, `H_k`, accepted or rejected, `i`, coupon, outcome, prize and slot.
- The transparency page explains how to recompute the seed and a step with `sha256sum`.
- It also links an open-source verifier (DRAW-INTEGRITY item 7). The verifier is a single static page or script that takes the manifest file and the 20 extracts and prints the same steps. It runs offline and never needs the platform.

## What happens to ADR 0014 §5 and ADR 0003

- **New rule versions.** ADR 0014 §5 (reopen, new round, new manifest, later draw) is replaced for every rule version with `vacancy_policy = in_app_draw`, which becomes the default for new campaigns.
- **Locked versions that say "reopens".** They keep that rule. The platform never rewrites a locked version and never changes the policy of a running campaign by itself (AC-08). Such a campaign changes only by publishing a new rules version while it is `open`, with an approver and a public announcement (ADR 0003 "Rules", `decideRuleChange`). Once the campaign has closed, its rules can no longer change, so the round is decided under "reopen".
- **ADR 0003 "Selection".** "The platform does not run a random draw of its own" becomes: the platform adds no randomness of its own. A vacant prize is decided by the published algorithm, applied to the randomness of an official draw named in the bases.
- **ADR 0014 Consequences.** "Anyone can check a result with the published manifest and the official extracts" still holds for both stages.

### Migration path for an open campaign whose bases say it reopens
1. **Owner approval.** The owner approves this ADR and the replacement texts in Appendix A.
2. **Legal confirmation.** Whoever handles the legal approval confirms that the approval on record covers the new mechanism. If the authority requires a new or amended approval, that blocks the change: approvals cannot change while the campaign is open (ADR 0003 "Gate", AC-12). See the open questions.
3. **Implementation.** The implementation (slice 3) is deployed to production and verified before step 4.
4. **The new bases version.** It is published before the closing date, Saturday 9 January 2027 at 20:00 (America/Argentina/Buenos_Aires). The safe deadline is several days earlier, so buyers have time to read it before the close.
   - **How.** It goes through Campaña › Bases, as a new version with `vacancy_policy = in_app_draw` and the public announcement in Appendix A. That writes the `rules_updated` entry in the transparency log, and the previous version stays visible as superseded.
   - **The pack.** It is updated in the same change for future loads. A production pack load (`client:load --update`) does not touch campaigns, so the in-app action is the path.
5. **Informing buyers.**
   - The campaign page and the transparency log show the announcement and the new version.
   - The site FAQ "¿Cómo y cuándo se realiza el sorteo?" is replaced (Appendix A), through Sitio › Preguntas frecuentes or the pack.
   - The organizer posts the announcement on Instagram and WhatsApp. Whether to email existing buyers is an open question: the platform today has no "campaign announcement" email, and buyers without marketing consent can only receive a transactional notice.
6. **If step 4 does not happen by the close.** The round is decided under "reopen", as the bases in force say.

## Code areas and tests (rough size)

| Area | Change | Size |
| --- | --- | --- |
| `packages/domain` | New `vacant-draw.ts`: candidates from a manifest, the seed text, the stream with rejection sampling and seat filling (mirroring `matchQuinielaDraw`), and the digest payload. The SHA-256 is injected or lives under `src/server` like `hashManifest`. `quinielaDigestPayload` covers stage 2. The `vacancyPolicy` type. | M |
| `packages/db` | Migration 0024: the `vacancy_policy` enum and column (existing rows `reopen`, default `in_app_draw`); table `vacant_draws` with `organization_id`, `app.apply_tenant_policy('vacant_draws')` and the append-only trigger, unique `(campaign_id, round, sequence)`; `prize_awards.vacant_draw_id` (nullable FK). | S |
| `apps/api` | `quinielaContext`, preview and confirm run stage 2 under `in_app_draw`. Reopen refuses `vacancy_policy_in_app_draw`. `PUT /rules` accepts `vacancyPolicy`. Supplementary schedule, preview and confirm routes (`campaigns.operate`). `/public/campaigns/:slug/vacant-draws`. `awardBoard`, `vacantSlots` and the `fulfilled` check understand slots with no candidate left. | M–L |
| `apps/worker` | No change. Award notifications, if any, follow the existing flow. | — |
| Public transparency page | The stage-2 section (seed, steps, download, how to verify), which award came from which stage, and supplementary announcements. Campaign page copy for the policy. | M |
| Admin UI | The policy select in Bases; the stage-2 preview in the Quiniela form; the reopen action hidden for `in_app_draw`; the supplementary draw form; the live search (FR-OPS-06) labels a stage-2 winner. | M |
| Verifier | A static page or script, offline, with no platform calls (DRAW-INTEGRITY item 7). | S |
| Docs | ADR 0014 and ADR 0003 amendments, DRAW-INTEGRITY item 5, a PRD requirement, the client's pack (Appendix A). | S |

Tests and acceptance criteria to add (Vitest against real Postgres for db and api, Playwright for flows):
- **Domain.** Golden vectors: a fixed manifest and fixed extracts give a fixed seed, fixed `H_k` and fixed steps. The vectors are published in the ADR or the docs, so third parties can check their own verifier. Also:
  - rejection at a forced `x ≥ limit`;
  - uniformity over many seeds (a chi-square bound, deterministic seeds);
  - `repeated` and `already_awarded` steps are skipped;
  - prize order and slot order;
  - alternates only for the slots filled in stage 2;
  - the walk stops when the candidates run out;
  - `n = 1`;
  - a stage 1 with no vacancy runs no stage 2.
- **DB.** Migration 0024 on a clean database and on one at 0023: existing rule versions read `reopen`, and locked rows stay byte-identical. `vacant_draws` isolation and append-only.
- **API.**
  - Under `in_app_draw`, confirming awards every vacant slot in one transaction, and the digest mismatches if a manual award changes in between.
  - Under `reopen`, behavior is byte-identical to today (PRESERVE for `quiniela-draw.test.ts` and `quiniela-rounds.test.ts`).
  - Reopen refuses `vacancy_policy_in_app_draw`.
  - A new version while `open` switches the policy; after close it is refused (`campaign_finished`).
  - Supplementary draw: refused before the announcement plus 24 hours, or for a slot that is not late-vacant.
  - The public JSON recomputes to the stored awards.
- **E2E.** An admin records the Quiniela draw with few coupons and sees both stages in the preview. They confirm and publish. The transparency page shows the steps, and the downloaded JSON verifies with the offline verifier.
- **PRD acceptance criterion** (proposed AC-xx): "Un premio vacante se decide entre los cupones del manifiesto publicado, sin reabrir ventas, y cualquiera puede recomputar el resultado con el manifiesto, el extracto oficial y el algoritmo publicado."

## Open questions for the owner

1. **Source.** Do you approve option A (the same night's extract seeds the vacant draw), with option B only for late vacancies, and no drand?
2. **Timing.** Stage 2 runs right after the Quiniela matching, on the same night and in the same broadcast. Or do you prefer a separate moment, which would mean option B for every vacancy?
3. **Live stream.** Is stage 2 shown live, with the admin preview on screen and the steps read out? That is recommended, since the live coupon search already exists.
4. **Legal.** Does the approval on record for the open campaign cover the new mechanism, or does the authority or notary need to approve it? If it does, the change cannot be made while the campaign is open.
5. **No candidates left** (fewer unawarded coupons than prizes). What do the bases say happens to that prize: declared void and kept by the organization, or another destination the authority requires? Legal advice is needed.
6. **Late vacancies.** Is a later named Quiniela draw, announced at least 24 hours before (option B), acceptable? Or should a declined winner with no alternates simply leave the prize void?
7. **A suspended official draw.** The bases do not say what happens if the named Quiniela draw is suspended. Should the new version add "the next official draw of the same Quiniela"?
8. **Informing buyers.** Is the announcement on the campaign page, the transparency log, the FAQ and social media enough, or do you also want a transactional notice to every buyer?
9. **Deadline.** By what date must the new bases version for the open campaign be published (before 9 January 2027 at 20:00)?

## Consequences

- Winners are known the night of the draw, even with few coupons sold. Sales close once, when announced.
- Every result is still a function of public data: the manifest, the official extracts and a versioned algorithm. The platform adds no randomness.
- Rounds stay in the code for the `reopen` policy and for history. They are not removed, because campaigns under that policy still exist.
- The stage-2 algorithm is versioned (`sortea.vacant-draw.v1`). Any change is a new version, and a locked rule version keeps the one it names.

## Appendix A: replacement texts

The Spanish replacement texts for the first client (its bases section "Premios vacantes", the announcement of the new bases version and the FAQ answer) are drafted in that client's private pack notes, `clients/<client>/docs/`, which the public copy leaves out (ADR 0021).
