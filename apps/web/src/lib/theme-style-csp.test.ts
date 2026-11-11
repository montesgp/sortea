import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { allowThemeStyle, themeStyleText } from './theme-style-csp';

// Staging 2026-11-10: the site looked different from local development. The organization's theme is an
// inline <style> (colors, fonts, light and dark modes), and the production CSP (`style-src 'self'`)
// blocked it; Vite's dev server allows inline styles, so it only showed once deployed.

const css = ':root{--accent:#D92626;--font-display:\'Big Shoulders Display\'}';
const hash = (text: string) => `'sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}'`;
const policy = "default-src 'self'; style-src 'self'; style-src-attr 'unsafe-inline'; img-src 'self' data:";

describe('theme style in the CSP', () => {
	it('allows exactly the inlined theme by its hash, and nothing else', () => {
		const allowed = allowThemeStyle(policy, css);
		expect(allowed).toBe(`default-src 'self'; style-src 'self' ${hash(css)}; style-src-attr 'unsafe-inline'; img-src 'self' data:`);
		expect(/(?:^|;\s*)style-src ([^;]*)/.exec(allowed!)![1]).toBe(`'self' ${hash(css)}`);
		expect(allowed!.match(/style-src /g)).toHaveLength(1);
	});

	it('hashes the text exactly as it is inlined, without any closing style tag', () => {
		expect(themeStyleText('a{}</style><script>x</script>')).toBe('a{}><script>x</script>');
		const inlined = themeStyleText(`${css}</STYLE>`);
		expect(allowThemeStyle(policy, `${css}</STYLE>`)).toContain(hash(inlined));
	});

	it("leaves a style-src that already allows 'unsafe-inline' alone, since a hash would disable it", () => {
		const dev = "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self'";
		expect(allowThemeStyle(dev, css)).toBe(dev);
	});

	it('leaves the policy alone when there is no theme or no style-src', () => {
		expect(allowThemeStyle(policy, '')).toBe(policy);
		expect(allowThemeStyle("default-src 'self'", css)).toBe("default-src 'self'");
		expect(allowThemeStyle(null, css)).toBeNull();
	});
});
