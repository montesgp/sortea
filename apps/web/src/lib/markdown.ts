import { Marked } from 'marked';

/**
 * Markdown for admin-authored text (rules, legal pages). Raw HTML is escaped
 * before parsing and links are limited to http(s) and mailto, so stored text
 * cannot inject markup or script URLs.
 */
const marked = new Marked({
	gfm: true,
	breaks: false,
	walkTokens(token) {
		if (token.type === 'link' && !/^(https?:|mailto:)/i.test(token.href)) token.href = '#';
		if (token.type === 'image') token.href = /^https:/i.test(token.href) ? token.href : '';
	}
});

const escapeHtml = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function renderMarkdown(source: string): string {
	return marked.parse(escapeHtml(source), { async: false });
}
