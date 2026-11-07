# ADR 0019: Tracking links per video

Status: accepted, 2026-11-07 (odd/tasks/tracking-links.md)

## Context

The organization shares the store in videos and posts on Instagram, Facebook, TikTok and other networks, and wants to know how much each video brought: how many purchases, buyers and chances, and how much money. The owner asked: "Tendremos oportunidad de registrar desde que links vienen a la tienda? ... seria interesante guardar cuantas chances (en dinero total) genero cada video", and later: "Cuando me refiero al origen son redes sociales, el usuario viene desde ahi, no se si tenemos forma de determinar si vino de un video X."

Social networks do not tell the site which video a visitor watched. At most the browser sends a `Referer` with the network's host, and not always; never the post. Only a link of its own identifies a video.

## Decision

- **One link per video.** The back office creates named tracking links, each with its campaign, its network and a generated 8-character code. The link is a site address with the code (`/?src=<code>`) that is pasted in the video or post. Links are archived, never deleted, and codes are never reused.
- **First-party cookie until the campaign closes.** A visit through an active link records the touch in the `sortea_src` cookie (no personal data, `httpOnly`; SECURITY.md), remembered until the link's campaign closes, and the address loses the code through a 303 redirect. A visit without a link from a known network remembers only that network, for 30 days. No third-party trackers.
- **Credit every link plus the last one.** A purchase stores every valid link its buyer came through and marks the most recent as the last. Reports show both "participó" (every link the buyer passed through) and "último" (only the last link, so the "último" rows plus "Sin link" add up to the campaign total). A purchase without a valid link appears as "Sin link", with the network guessed from the referrer when known.
- **Only paid purchases count.** Visits are not counted. A refunded or charged-back purchase stops counting.
- **Net as reported by Mercado Pago.** The net amount is the payment's net that Mercado Pago reported (ADR 0018); purchases whose net is not known yet are counted and flagged, never estimated.

## Consequences

- Without its own link a video cannot be told apart: purchases from a shared store link, a bio link, a story without a link or a copied address appear as "Sin link", at best with the network. The back office guide says so, and the privacy policy describes the cookie.
- A buyer who clears cookies, switches devices or browsers, or arrives after the campaign closes is not attributed. The figures are a lower bound, not a census.
- The cookie keeps at most ten links per visitor; an older touch drops out first.
- Reports are computed in memory from the campaign's paid purchases (`packages/domain`), which is enough at current scale. Larger volumes would need aggregation in SQL or stored summaries.
