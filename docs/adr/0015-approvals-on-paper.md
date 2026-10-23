# ADR 0015: The organization owner can attest approvals documented on paper

Status: accepted, 2026-10-22. Amends the approval evidence rule of AC-12 and AGENTS.md; ADR 0013 is unchanged.

## Context

AC-12 keeps a campaign from opening until its required approvals (legal and PSP) are on record. Until now, each approval had to be recorded with an authority and an expediente or case number, and the gate accepted an approval only when it had that reference.

The owner has the approvals, but only on paper: "el sistema da todo por aprobado sin esperar numeros de expendientes y demas informacion que no tenemos digital sino en papel" (odd/tasks/owner-feedback-2026-10-22.md, S3). Typing a made-up number to satisfy the form would break the rule that the platform never invents authorizations, permit numbers or PSP approvals. Leaving the gate as it was would keep a properly authorized campaign closed.

Owner decision (L3): "Constancia en papel".

## Decision

- **A statement by the owner.** The campaign's Aprobaciones section has a checkbox: "Todas las aprobaciones están otorgadas y su documentación está en papel". Only a user with `campaigns.approve` can check or uncheck it, which today means the organization owner (and the platform superadmin). Other roles get 403, and the panel does not offer the checkbox. API: `PUT /admin/campaigns/:id/paper-attestation` with `{ attested: boolean }`.
- **What checking records.** Every required approval kind (`campaigns.required_approvals`) that is not already satisfied by a reference becomes `approved` with `basis = 'paper'`. The row records who decided it and when. Authority and reference stay as they were, usually empty: nothing is invented. Approvals already recorded with a reference are left untouched.
- **A rejection is overridden.** A rejected approval becomes approved on paper too, because the attestation is the owner's explicit statement. The audit event keeps the status each kind had before.
- **The gate.** An approval is satisfied when its status is `approved`, `decided_at` is set, and either its reference is set (`basis = 'document'`) or `basis = 'paper'` (`approvalSatisfied` in `packages/domain`). A database check keeps `paper` rows approved, dated and attributed.
- **Undoing it.** Unchecking returns only the paper rows to `pending` (`basis` back to `document`, decision cleared). Rows recorded with a reference stay as they are. Like any approval change, attesting and clearing are refused with `approvals_locked` once the campaign is open.
- **Audited.** Each change writes one audit event: `campaign.approvals_attested` with the kinds affected and their previous status, or `campaign.approvals_attestation_cleared` with the kinds returned to pending. Both carry the actor and the campaign.
- **The per-kind form stays.** Recording an approval with its authority and reference works as before (`basis = 'document'`). Saving that form over a paper row turns it into a document approval.
- **Shown honestly.** The public Autorizaciones section shows a paper approval as "Aprobada" with "Constancia en papel" instead of an authority and expediente number. Its explanation says that approvals are recorded with their expediente number or with the paper attestation of the organization.
- **Seed and demo data.** Seeds and demo campaigns keep their approvals `pending`, and the local demo mode (ADR 0013) still waives pending approvals without writing anything.

## Consequences

- An organization whose approvals exist only on paper can open its campaign without typing invented numbers.
- The digital evidence is weaker: the platform holds the owner's statement, not the authority and number. The paper documents remain the proof and must be kept by the organization. Recording the reference later through the per-kind form strengthens the record.
- The owner is accountable for the statement. The audit trail and `decided_by` show who made it and when, and the public page does not present it as an expediente.
- Supersedes the part of the AC-12 evidence rule that required a reference for every approval. The rule that the platform never invents approvals stays: a person records each one.
