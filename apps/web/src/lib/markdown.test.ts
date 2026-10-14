import { describe, expect, it } from 'vitest';
import { renderMarkdown } from './markdown';

describe('renderMarkdown', () => {
	it('renders basic formatting', () => {
		expect(renderMarkdown('# Bases\n\n- **Uno**')).toContain('<strong>Uno</strong>');
	});

	it('escapes raw HTML instead of rendering it', () => {
		const html = renderMarkdown('<script>alert(1)</script><img src=x onerror=alert(1)>');
		expect(html).not.toContain('<script>');
		expect(html).not.toContain('<img');
	});

	it('neutralizes script links', () => {
		expect(renderMarkdown('[clic](javascript:alert(1))')).not.toContain('javascript:');
		expect(renderMarkdown('[sitio](https://example.com)')).toContain('href="https://example.com"');
	});
});
