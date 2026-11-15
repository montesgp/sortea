import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import AnnouncementBar from './AnnouncementBar.svelte';

// Owner feedback 2026-11-15 S3: with its option on, the bar shows the campaign
// accepting participations that closes first, linked to the shop, instead of
// its own text; with none open, its own text when it is on.

const text = (html: string) => html.replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const own = { enabled: true, text: 'Estamos en un sitio de pruebas', linkUrl: null, linkLabel: null };
const campaign = { slug: 'moto', title: 'Moto 0 km', closesAt: '2026-11-28T23:00:00.000Z' };
const timezone = 'America/Argentina/Buenos_Aires';
const bar = (announcement: Record<string, unknown> | undefined, closingCampaign: typeof campaign | null) =>
	render(AnnouncementBar, { props: { announcement: announcement as never, closingCampaign, timezone } }).body;

describe('announcement bar (S3)', () => {
	it('shows the campaign closing first with its closing time and a link to the shop', () => {
		const html = bar({ ...own, showClosingCampaign: true }, campaign);
		expect(text(html)).toBe('Participaciones abiertas para Moto 0 km hasta el 28/11/2026 20:00 Participá');
		expect(html).toMatch(/<a [^>]*href="\/tienda"[^>]*>Participá<\/a>/);
	});

	it('shows its own text when no campaign accepts participations, and nothing when that text is off', () => {
		expect(text(bar({ ...own, showClosingCampaign: true }, null))).toBe('Estamos en un sitio de pruebas');
		expect(text(bar({ ...own, enabled: false, showClosingCampaign: true }, null))).toBe('');
	});

	it('shows the campaign even when its own text is off', () => {
		expect(text(bar({ ...own, enabled: false, showClosingCampaign: true }, campaign))).toContain('Participaciones abiertas para Moto 0 km');
	});

	it('keeps its own text with the option off, and nothing without an announcement', () => {
		expect(text(bar({ ...own, showClosingCampaign: false }, campaign))).toBe('Estamos en un sitio de pruebas');
		expect(text(bar(undefined, campaign))).toBe('');
	});
});
