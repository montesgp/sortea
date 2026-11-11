import { createHash } from 'node:crypto';

/**
 * The organization's theme (colors, fonts, light and dark modes) is inlined in app.html. The CSP allows
 * styles from the site only (`style-src 'self'`), so the inline block is allowed by its exact hash: no
 * other inline style is, and the policy stays as strict as before.
 */

/** The theme text exactly as it is inlined: a closing style tag could end the block early. */
export function themeStyleText(css: string): string {
	return css.replace(/<\/style/gi, '');
}

/** Adds the hash of the inlined theme to `style-src`; returns the policy unchanged when there is nothing to allow. */
export function allowThemeStyle(policy: string | null, css: string): string | null {
	if (!policy || !css) return policy;
	const hash = createHash('sha256').update(themeStyleText(css), 'utf8').digest('base64');
	return policy.replace(/(^|;\s*)style-src ([^;]*)/, (match, lead: string, sources: string) =>
		// A hash makes browsers ignore 'unsafe-inline' (CSP Level 2), which would block the dev server's inline styles.
		sources.includes("'unsafe-inline'") ? match : `${lead}style-src ${sources.trim()} 'sha256-${hash}'`
	);
}
