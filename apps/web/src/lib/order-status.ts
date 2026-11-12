/**
 * How the result page asks again while a payment is awaited: two minutes, and with the first load
 * within the 30 requests in 5 minutes `/checkout/orders/status` allows a client (S7, owner feedback 2026-11-11b).
 */
export const STATUS_POLL = { intervalMs: 5_000, rounds: 24 } as const;
