import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Resvg } from '@resvg/resvg-wasm';
import { platformTheme, type FontFamily } from '@sortea/domain';
import { describe, expect, it } from 'vitest';
import { readTicketImage, renderTicket, TICKET_MAX_BYTES, TICKET_MAX_NUMBERS, TICKET_WIDTH, ticketSvg, ticketView, type TicketBrand } from '../src/ticket';

// Owner feedback 2026-11-10 S9: a ticket in the organization's style that the buyer can save
// on the phone, attached to the purchase email. No wallets for now. The ticket carries the
// brand, the campaign, the buyer's first name, the order reference, the coupons, the draw date
// and the site; never the document, email, phone or last name.

const palette = platformTheme.dark;
const brand: TicketBrand = {
	name: 'Taller Demo',
	palette,
	fontDisplay: 'big-shoulders',
	fontBody: 'archivo',
	radius: 12,
	logo: null,
	site: 'tallerdemo.example'
};
// The fictional Taller Demo logo the web serves (apps/web/static/tenants/taller-demo).
const logo = { contentType: 'image/png' as const, bytes: new Uint8Array(readFileSync(new URL('../../web/static/tenants/taller-demo/logo.png', import.meta.url))) };

// A stored order carries more than the ticket may show: everything but the first name stays off it.
const storedOrder = {
	reference: 'MG-TEST0001',
	buyer: { firstName: 'Juana', lastName: 'Pérezgonzález', email: 'juana.secreta@example.com', phone: '+54 9 11 2345-6789', province: 'Córdoba', city: 'Río Cuarto' },
	document: '30123456'
};
const campaign = { title: 'Moto 0 km & casco <edición 2026>', entryDigits: 4, drawAt: new Date('2026-12-13T00:00:00Z'), timezone: 'America/Argentina/Buenos_Aires' };
const view = (numbers: readonly number[], overrides: Partial<TicketBrand> = {}) => ticketView({ brand: { ...brand, ...overrides }, campaign, order: storedOrder, numbers });

/** The words the ticket draws, in order, as a reader sees them (long lines wrap into several texts). */
const shownText = (svg: string) =>
	[...svg.matchAll(/<text[^>]*>([^<]*)<\/text>/g)]
		.map((match) => match[1]!)
		.join(' ')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&amp;/g, '&');

/** Width and height from the PNG header (IHDR). */
function pngSize(png: Uint8Array): { width: number; height: number } {
	const data = new DataView(png.buffer, png.byteOffset, png.byteLength);
	return { width: data.getUint32(16), height: data.getUint32(20) };
}
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const require = createRequire(import.meta.url);
const fontBuffers = ['archivo/400Regular/Archivo_400Regular', 'archivo/700Bold/Archivo_700Bold', 'big-shoulders/400Regular/BigShoulders_400Regular', 'big-shoulders/700Bold/BigShoulders_700Bold', 'inter-tight/400Regular/InterTight_400Regular', 'inter-tight/700Bold/InterTight_700Bold'].map(
	(path) => new Uint8Array(readFileSync(require.resolve(`@expo-google-fonts/${path}.ttf`)))
);
/** Where the ticket's text ends on the right, as resvg draws it (resvg is ready once a ticket was built). */
function textRight(svg: string): number {
	const [, width, height] = svg.match(/<svg[^>]* width="(\d+)" height="(\d+)"/)!;
	const texts = svg.match(/<text[^>]*>[^<]*<\/text>/g)!.join('');
	const resvg = new Resvg(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${texts}</svg>`, { font: { fontBuffers, defaultFontFamily: 'Archivo' } });
	const box = resvg.getBBox()!;
	const right = box.x + box.width;
	box.free();
	resvg.free();
	return right;
}
/** The ticket's content box ends 96 px (border and padding) before the right edge. */
const CONTENT_RIGHT = TICKET_WIDTH - 96;
const fonts: FontFamily[] = ['archivo', 'big-shoulders', 'inter-tight'];

describe('purchase ticket (S9)', () => {
	it('shows the brand, campaign, first name, reference, padded coupons, draw date and site', async () => {
		const svg = await ticketSvg(view([7, 8, 1234]));
		// Escaped in the SVG, shown as typed.
		expect(svg).not.toContain('<edición');
		expect(shownText(svg)).toContain('Moto 0 km & casco <edición 2026>');
		for (const shown of ['Taller Demo', 'Juana', 'MG-TEST0001', 'N.º 0007', 'N.º 0008', 'N.º 1234', '3 chances', 'FECHA DEL SORTEO', 'sábado 12 de diciembre de 2026, 21:00 h', 'tallerdemo.example']) {
			expect(svg, shown).toContain(shown);
		}
		// The organization's theme: its colors and fonts.
		expect(svg).toContain(palette.bg);
		expect(svg).toContain(palette.accent);
		expect(svg).toContain('font-family="Big Shoulders"');
		expect(svg).toContain('font-family="Archivo"');
	});

	it('never carries the document, email, phone, last name or place of the buyer', async () => {
		const svg = await ticketSvg(view([7]));
		for (const hidden of ['30123456', 'juana.secreta', '@example.com', '2345-6789', 'Pérezgonzález', 'Córdoba', 'Río Cuarto']) {
			expect(svg, hidden).not.toContain(hidden);
		}
		expect(Object.keys(view([7]))).not.toEqual(expect.arrayContaining(['lastName', 'email', 'phone']));
	});

	it('names one chance in singular and leaves the draw date out when it is not known', async () => {
		const svg = await ticketSvg(ticketView({ brand, campaign: { ...campaign, drawAt: null }, order: storedOrder, numbers: [42] }));
		expect(svg).toContain('1 chance');
		expect(svg).not.toContain('1 chances');
		expect(svg).not.toContain('FECHA DEL SORTEO');
		expect(svg).toContain('N.º 0042');
	});

	it('lists up to the cap and says how many more there are', async () => {
		const numbers = Array.from({ length: TICKET_MAX_NUMBERS + 15 }, (_, index) => index);
		const svg = await ticketSvg(view(numbers));
		expect(svg).toContain(`N.º ${String(TICKET_MAX_NUMBERS - 1).padStart(4, '0')}`);
		expect(svg).not.toContain(`N.º ${String(TICKET_MAX_NUMBERS).padStart(4, '0')}`);
		expect(svg).toContain('y 15 chances más');
		expect(svg).toContain(`${TICKET_MAX_NUMBERS + 15} chances`);
	});

	it('embeds the logo when there is one, instead of the name as a heading', async () => {
		const withLogo = await ticketSvg(view([7], { logo }));
		expect(withLogo).toContain('href="data:image/png;base64,');
		expect(await ticketSvg(view([7]))).not.toContain('<image');
	});

	it('renders a portrait PNG, 1080 px wide, under 300 KB, also with a logo and the most coupons', async () => {
		for (const [numbers, extra] of [
			[[7], {}],
			[Array.from({ length: 200 }, (_, index) => index * 37), { logo }],
			[Array.from({ length: TICKET_MAX_NUMBERS }, (_, index) => 900_000 + index), { logo, fontDisplay: 'archivo', fontBody: 'inter-tight' }]
		] as const) {
			const digits = numbers[0]! >= 900_000 ? 6 : 4;
			const png = await renderTicket(ticketView({ brand: { ...brand, ...extra }, campaign: { ...campaign, entryDigits: digits }, order: storedOrder, numbers }));
			expect([...png.slice(0, 8)]).toEqual(PNG_SIGNATURE);
			const size = pngSize(png);
			expect(size.width).toBe(TICKET_WIDTH);
			expect(size.height).toBeGreaterThan(size.width);
			expect(png.byteLength).toBeLessThan(TICKET_MAX_BYTES);
		}
	});

	it('keeps every line inside the ticket, breaking a word too long for one line wherever it falls', async () => {
		const long = 'Superextraordinariamenteinmejorableyespectacular'.repeat(2);
		for (const [name, title] of [
			[`${long} Taller`, `${long} y casco`],
			[`Taller ${long} del Oeste`, `Moto ${long} casco ${long} campera`]
		] as const) {
			const svg = await ticketSvg(ticketView({ brand: { ...brand, name, site: 'tallerdemo.example' }, campaign: { ...campaign, title }, order: storedOrder, numbers: [7] }));
			expect(textRight(svg), `${name} / ${title}`).toBeLessThanOrEqual(CONTENT_RIGHT + 1);
			// The words are broken, not dropped: the start of the long word is still shown.
			expect(shownText(svg)).toContain('Superextraordinaria');
		}
	});

	it('shortens a very long first name with an ellipsis, so the number of chances always shows', async () => {
		const firstName = 'Maximilianoalejandro'.repeat(4);
		const svg = await ticketSvg(ticketView({ brand, campaign, order: { ...storedOrder, buyer: { ...storedOrder.buyer, firstName } }, numbers: [7, 8, 9] }));
		expect(svg).toMatch(/Maximilianoalejandro[^<]*… · 3 chances<\/text>/);
		expect(svg).not.toContain(firstName);
		expect(textRight(svg)).toBeLessThanOrEqual(CONTENT_RIGHT + 1);
		// A short name is shown whole.
		expect(await ticketSvg(view([7, 8, 9]))).toContain('>Juana · 3 chances</text>');
	});

	it('stays within 300 KB without a logo in the worst case, in every theme font', { timeout: 180_000 }, async () => {
		// A rounder ticket, a two-line name, a three-line title, a long site and 40 six-digit coupons.
		const worst = (fontDisplay: FontFamily, fontBody: FontFamily, mode: 'dark' | 'light') =>
			ticketView({
				brand: { name: 'Taller de Motocicletas y Restauraciones Integrales del Oeste Bonaerense', palette: platformTheme[mode], fontDisplay, fontBody, radius: 16, logo: null, site: 'tallerdemotocicletas-restauraciones.example' },
				campaign: { title: 'Gran sorteo aniversario: moto 0 km, casco, campera y accesorios de regalo para toda la temporada 2026', entryDigits: 6, drawAt: campaign.drawAt, timezone: campaign.timezone },
				order: { reference: 'MG-ABCDEFGH', buyer: { firstName: 'Maximiliano' } },
				numbers: Array.from({ length: 200 }, (_, index) => 900_000 + index * 2371)
			});
		for (const mode of ['dark', 'light'] as const) {
			for (const fontDisplay of fonts) {
				for (const fontBody of fonts) {
					const png = await renderTicket(worst(fontDisplay, fontBody, mode));
					expect([...png.slice(0, 8)]).toEqual(PNG_SIGNATURE);
					expect(pngSize(png).width).toBe(TICKET_WIDTH);
					expect(png.byteLength, `${mode} ${fontDisplay}/${fontBody}`).toBeLessThanOrEqual(TICKET_MAX_BYTES);
				}
			}
		}
	});

	it('renders the same bytes for the same order, so every retry sends the same email', async () => {
		const first = await renderTicket(view([7, 8]));
		expect(Buffer.from(await renderTicket(view([7, 8]))).equals(Buffer.from(first))).toBe(true);
	});
});

describe('ticket logo bytes (S9)', () => {
	it('refuses a cut-off PNG or JPEG, so the ticket shows the name instead of an empty logo', async () => {
		const png = await renderTicket(ticketView({ brand, campaign, order: storedOrder, numbers: [7] }));
		expect(await readTicketImage(png)).toMatchObject({ contentType: 'image/png' });
		expect(await readTicketImage(png.slice(0, png.length >> 1))).toBeNull();
		expect(await readTicketImage(png.slice(0, png.length - 1))).toBeNull();
		// A baseline JPEG header announcing 16 x 16, then nothing: no scan and no end marker.
		const header = [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00];
		const sof = [0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x10, 0x00, 0x10, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01];
		expect(await readTicketImage(Uint8Array.from([...header, ...sof]))).toBeNull();
	});
});
