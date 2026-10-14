# ADR 0004: Sealed tenant secrets and account-free buyer access

Status: accepted, 2026-10-14

## Tenant secrets

Mercado Pago tokens and webhook secrets are sealed with AES-256-GCM using a versioned key ring (`SECRETS_KEY_RING=v1:…,v2:…`). The organization and integration ids are bound as additional authenticated data, so a ciphertext copied to another tenant does not decrypt. New writes use the newest key; older versions stay readable for rotation. Responses only carry a masked hint (`APP_••••1234`); secrets are write-only from the console (AC-05).

## Buyer lookup

Buyers have no accounts (FR-COM-03). They reach their purchases in two ways:

- **Document + one-time code.** The start endpoint answers identically for known and unknown documents, creates a challenge either way, and only enqueues an email when the document exists. Codes are six digits, stored as peppered HMACs, valid for ten minutes, five attempts. The plaintext code travels sealed through the outbox and is opened only by the worker that emails it. Rate limits apply per client and per contact (AC-07).
- **Receipt reference + access code**, shown after checkout. The session is limited to that order.

A contact's email is set by its first purchase and never overwritten by later checkouts; each order keeps its own buyer snapshot. Typing someone else's document cannot redirect their codes.

## Downloads

Digital files sit in a private bucket. Download grants are random tokens (stored hashed) with an expiry and a download cap; each use returns a 60-second signed URL. Buyers can request new grants from the lookup.
