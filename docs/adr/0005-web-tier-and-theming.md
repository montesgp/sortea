# ADR 0005: SvelteKit as BFF, tokens-only theming, opt-in signature treatments

Status: accepted, 2026-10-14

## Decision

- **BFF.** SvelteKit 3 renders every page on the server and talks to the API with the internal token and the real request hostname. Browsers never see the API or provider tokens. Admin sign-in goes from the web server to the API (ADR 0020): the API checks the password and the TOTP code and returns an opaque session token, which the web keeps in an httpOnly cookie on `/admin` and sends with every admin call; the API looks the session up each time. Production requires a session confirmed with the second factor (`REQUIRE_ADMIN_MFA`).
  - *Superseded 2026-11-09 (ADR 0020):* until then sign-in used Supabase Auth's REST API from the server, with its tokens in httpOnly cookies verified by the API against the project's JWKS.
- **Theming.** Organizations provide design tokens, never CSS. Tokens are validated (hex colors, allow-listed fonts) and every text/background pair is checked for WCAG AA; failing pairs fall back to platform values. The resolved CSS is injected per hostname into a nonce'd `<style>` under a strict CSP (AC-10).
- **Signature treatments.** Brand-specific experiences are content switches, not code forks: `home.heroStyle = garage` and `home.processStyle = pistons` enable the first client's roller-shutter hero and piston cycle; other organizations get the neutral hero and list.
- **Motion.** GSAP drives one entrance sequence and one scroll-scrubbed section. A tiny inline script marks `html.motion` before first paint only when reduced motion is not requested; without it, or if scripts fail to start within a few seconds, the page renders its final state.
- **Forms.** Every flow works without client JavaScript (form actions, cookies). Inputs use `defaultValue` so hydration never erases what a visitor already typed.
