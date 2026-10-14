# ADR 0005: SvelteKit as BFF, tokens-only theming, opt-in signature treatments

Status: accepted, 2026-10-14

## Decision

- **BFF.** SvelteKit 3 renders every page on the server and talks to the API with the internal token and the real request hostname. Browsers never see the API, Supabase keys or provider tokens. Admin sign-in uses Supabase Auth's REST API from the server; tokens live in httpOnly cookies and the API verifies them against the project's JWKS. Production requires an `aal2` (MFA) session.
- **Theming.** Organizations provide design tokens, never CSS. Tokens are validated (hex colors, allow-listed fonts) and every text/background pair is checked for WCAG AA; failing pairs fall back to platform values. The resolved CSS is injected per hostname into a nonce'd `<style>` under a strict CSP (AC-10).
- **Signature treatments.** Brand-specific experiences are content switches, not code forks: `home.heroStyle = garage` and `home.processStyle = pistons` enable MotoGarage's roller-shutter hero and piston cycle; other organizations get the neutral hero and list.
- **Motion.** GSAP drives one entrance sequence and one scroll-scrubbed section. A tiny inline script marks `html.motion` before first paint only when reduced motion is not requested; without it, or if scripts fail to start within a few seconds, the page renders its final state.
- **Forms.** Every flow works without client JavaScript (form actions, cookies). Inputs use `defaultValue` so hydration never erases what a visitor already typed.
