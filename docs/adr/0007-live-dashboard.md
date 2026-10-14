# ADR 0007: Live dashboard through Postgres NOTIFY and server-sent events via the BFF

Status: accepted, 2026-10-14

## Context

FR-OPS-02 asks for near-real-time dashboard updates "through private Broadcast plus snapshot/resync", and AC-04 requires the dashboard to receive events and resync after losing its connection. Supabase Realtime Broadcast would have the browser connect to Supabase with the admin's access token. That contradicts ADR 0005: browsers never see Supabase, the API or any token, which live in httpOnly cookies. ADR 0001 already noted that Realtime cannot read the private `app` schema. The product owner chose to keep ADR 0005 and depart from the PRD's wording; the requirement itself (private, near real time, snapshot and resync) is met.

## Decision

- **Notices, not data.** A change that matters to the dashboard writes a row to `ops_events` (kind and subject id only; no amounts, names or contact data) in the same transaction as the change. The dashboard reacts to any notice by re-reading its snapshot, so a lost notice costs a delay, never a wrong number.
- **Commit-ordered sequence.** Each organization has a counter in `ops_sequences`. Publishing increments it under a row lock held until commit, so sequence order is commit order and a client resuming after N cannot miss an event below N. Publishing is the last step of a transaction to keep that lock short.
- **Delivery.** A trigger calls `pg_notify` on insert; Postgres delivers notifications on commit, so rolled-back changes are never announced. Each API process holds one `LISTEN` connection and fans notices out to the open streams of the matching organization. When that connection reconnects, every stream is told to resync, because notifications sent meanwhile are lost.
- **Stream.** `GET /admin/events` (permission `dashboard.view`) is a server-sent event stream. It resumes after `Last-Event-ID`, or after the snapshot's `lastEventId` on first connect. It subscribes before reading history and drops duplicates by sequence, so nothing falls between replay and live delivery. It replays up to 200 missed events; when the gap is larger, events were pruned, or the client is ahead of the server, it sends `resync`. Streams end after ten minutes and the browser reconnects, which re-checks the token and the role. At most 50 streams per organization.
- **BFF.** The browser opens `/admin/eventos` on its own origin with its session cookie; SvelteKit forwards the API stream with the internal token and aborts it when the page closes. If the stream is refused, the page falls back to polling every 30 seconds.
- **Retention.** The worker deletes notices older than seven days. Tenants can insert and read their own notices but not change or delete them.

## Consequences

- No new service, key or browser credential. Several API instances work because every instance listens to the same database.
- `LISTEN` needs a session connection. On Supabase Cloud, the API must use the direct connection or the session pooler (port 5432), not the transaction pooler.
- Long-lived connections must pass through every proxy in front of the web and API services without buffering (`x-accel-buffering: no` is set) and without an idle timeout shorter than the 25-second heartbeat.
