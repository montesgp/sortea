# ADR 0003: Participation integrity and the compliance gate

Status: accepted, 2026-10-14

## Context

The platform records participations and publishes evidence, but it must not define or enable any modality that has not been authorized (PRD §1, DRAW-INTEGRITY).

## Decision

- **Gate.** A campaign declares required approvals (legal, payment provider). It can be published for information, but `published → open` is refused unless every required approval is `approved` with an authority and a reference. Approvals cannot change while the campaign is open (AC-12).
- **Rules.** Opening locks the latest rule version and stores its SHA-256. A trigger forbids editing or deleting locked versions; after opening, the only change path is a new version with an approver and a public announcement, which supersedes the previous one and appears in the transparency log (AC-08).
- **Entries.** Allocation follows the locked rule (`entriesPerUnit` per variant, optional cap per identity). Numbers come from a counter on the locked campaign row. Entries are immutable except `eligible → void`; every change has a ledger event, and the ledger is append-only.
- **Chances.** Admins set `entriesPerUnit` per variant ("chances por unidad", 0 = does not participate) while the rules are editable. Buyers see chances only from the locked rule of a campaign accepting participations; the API quote counts them with `computeEntryAllocation`. A purchase without a chosen campaign, or naming one that no longer accepts participations (a stale cart), counts for the open campaign closing first, the same one the shop and cart quote. The published `contentHash` covers only the rules text, not `entryRule` (the chances); chances are still fixed because locked rule versions are immutable at the database level. Extending the hash to `entryRule` is a separate decision.
- **Close.** A campaign closes only after `closesAt + order TTL` (60 minutes), when every payment started before the close has settled or expired. Payments approved after `closesAt` keep the purchase but add no entries. Closing writes the canonical manifest (entry number, campaign-scoped pseudonym, status; no personal data), its SHA-256, and publishes both before any selection. The manifest row is immutable.
- **Selection.** The mechanism is recorded as evidence in the public log once it is authorized; the platform does not run a random draw of its own.

## Consequences

- Anyone can download the manifest and recompute the hash (AC-11).
- Holder pseudonyms are HMACs of `campaign:contact` with a server pepper: stable within a campaign, unlinkable across campaigns, not reversible to a document.
