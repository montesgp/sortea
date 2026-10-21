# Compliance demo mode (2026-10-20)

The owner wants to rehearse a campaign locally as if it were real (participate button, highlighted chances, purchase with numbered chances) while the legal and PSP approvals are still pending.
Approvals are never invented: a local-only demo mode waives the pending approvals of campaigns marked as demo, with a visible notice, and refuses to run in production.

## Specs

- S1 Owner request: "Si esta pendiente por aut legal o aprobacion del medio de pago, podemos simularlo momentaneamente?" Agreed scope (owner chose "Sí, implementarlo"): a variable `COMPLIANCE_DEMO=true`; the API configuration refuses it in production and when the payment simulator is off.
- S2 With the mode on, a campaign marked as demo (`isDemo`) can open and accept participations while its approvals are pending: the participate button works, products show their chances, a simulated purchase allocates numbered chances. "Aprobaciones siguen pending": approval rows are never written; a rejected approval still closes the gate.
- S3 Without the mode, or for a campaign not marked as demo, everything behaves as today (AC-12: `compliance_gate_closed`, no chances shown).
- S4 "Franja visible": while the mode is on, every public page shows "Demostración — sin validez legal ni pagos reales", and the admin campaign page says its approvals are waived by the demo mode.
- S5 An ADR records the exception; README/env docs name the variable.

## Tasks

- T1 [S1-S3] inline; done; domain gate option + API config + gate callers + tests (domain 21/21, api new 13/13, tsc clean).
- T2 [S4] inline; done; DemoModeBar in (site)/(campaign) layouts, public Autorizaciones text, admin gate notice (svelte-check 0 errors).
- T3 [S5] inline; done; docs/adr/0013, README, docs/launch/environment-setup.md.
- T4 [S1-S4] gentle-ai-verify (risk item 2: compliance guard); unavailable (subagent failed to start: "child exit unconfirmed; capacity quarantined"), not retried; inline checks only (L5).

## Log

L1: "Actualmente hay una campania iniciada, si bien es de prueba para probarla necesito que parezca real, y no estoy pudiendo ni participar por boton bloqueado, ni tampoco en los productos visualizo las chances que deberian existir bien resaltadas con colores por participar con la compra. Si esta pendiente por aut legal o aprobacion del medio de pago, podemos simularlo momentaneamente?"
L2: Environment: local (owner choice). Local DB: `tornado-300` published, is_demo=true, legal:pending, psp:pending, rule v1 draft. Cause confirmed: gate closed (campaign.ts:101) and participationCampaign returns null (campaign-state.ts:40-57). Marking approvals approved refused (AGENTS.md non-negotiable). Owner authorized the demo mode: "Sí, implementarlo".
L3: Design decision: the waiver needs all of COMPLIANCE_DEMO=true (non-production, simulator on), campaign.isDemo, and no rejected approval; the gate result keeps `missing` truthful and adds `demo: true`.
L4: RED observed: domain waiver 1 failing (2 pins passing), api config 5 + flow 5 failing (409, null chances, 0 entries, undefined flags); 3 pins passing (non-demo campaign and rejection still closed). GREEN after implementation. Also found: admin said "Las aprobaciones requeridas están registradas" whenever the gate allowed, and the public Autorizaciones text said the campaign only opens with approvals; both now state the demo waiver.
L5: Full suites green: domain 134/134, api 206/206, web 107/107, svelte-check 0 errors. Worker typecheck not run (npx tsc unresolved at root; worker imports none of the changed code). Inline checks: is_demo written only by the seed (no endpoint); all 7 gate call sites pass the flag explicitly (required parameter); approvals written only by the unchanged admin PUT. Commit f775ae7 (feat: local compliance demo mode). Local .env: COMPLIANCE_DEMO=true added (gitignored).
