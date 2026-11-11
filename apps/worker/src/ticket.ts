import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { initWasm, Resvg } from '@resvg/resvg-wasm';
import { formatEntryNumber, type FontFamily, type Palette } from '@sortea/domain';

/**
 * The purchase ticket (owner feedback 2026-11-10 S9): a PNG in the organization's style
 * that the buyer saves on the phone, attached to the purchase email and shown in its body.
 * No Apple or Google Wallet pass for now.
 *
 * The ticket is an SVG built here and rasterized by resvg compiled to WebAssembly: no native
 * module to build in the worker image, the same bytes for the same order on every retry, and
 * text drawn with the theme's own fonts (the static TTF builds of the Google Fonts families the
 * web serves as woff2, which resvg cannot read). It shows the brand, the campaign, the buyer's
 * first name, the order reference, the coupons, the draw date when it is known and the site;
 * never the document, email, phone, last name or place of the buyer (SECURITY.md).
 */

export const TICKET_WIDTH = 1080;
/** Kept small for the email: a bigger render drops the logo, the only part whose size is not ours. */
export const TICKET_MAX_BYTES = 300_000;
/** Coupons drawn on the ticket; the rest are counted, and the email and Consultar list them all. */
export const TICKET_MAX_NUMBERS = 40;

export interface TicketImage {
	readonly contentType: 'image/png' | 'image/jpeg' | 'image/svg+xml';
	readonly bytes: Uint8Array;
}

/** A logo larger than this on either side is left out: the ticket draws it at most 480 by 128. */
export const LOGO_MAX_SIDE = 4096;

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
// A whole file ends with its IEND chunk (PNG) or end-of-image marker (JPEG); a cut-off one would draw an empty logo.
const PNG_END = [0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82];
const JPEG_END = [0xff, 0xd9];

function endsWith(bytes: Uint8Array, tail: readonly number[]): boolean {
	return bytes.length >= tail.length && tail.every((byte, index) => bytes[bytes.length - tail.length + index] === byte);
}
const startsWith = (bytes: Uint8Array, prefix: readonly number[]) => prefix.every((byte, index) => bytes[index] === byte);

/** PNG size from its IHDR chunk, which the format puts first. */
function pngSize(bytes: Uint8Array): { width: number; height: number } | null {
	if (bytes.byteLength < 24 || String.fromCharCode(...bytes.slice(12, 16)) !== 'IHDR') return null;
	const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	return { width: data.getUint32(16), height: data.getUint32(20) };
}

/** JPEG size from its first frame header (SOF), walking the segments before it. */
function jpegSize(bytes: Uint8Array): { width: number; height: number } | null {
	let at = 2;
	while (at + 4 <= bytes.byteLength) {
		if (bytes[at] !== 0xff) return null;
		const marker = bytes[at + 1]!;
		if (marker === 0xff) {
			at += 1;
			continue;
		}
		if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
			at += 2;
			continue;
		}
		// Image data before any frame header: nothing to measure.
		if (marker === 0xda || marker === 0xd9) return null;
		const length = (bytes[at + 2]! << 8) | bytes[at + 3]!;
		if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
			if (at + 9 > bytes.byteLength) return null;
			return { height: (bytes[at + 5]! << 8) | bytes[at + 6]!, width: (bytes[at + 7]! << 8) | bytes[at + 8]! };
		}
		if (length < 2) return null;
		at += 2 + length;
	}
	return null;
}

/** An SVG document, after an optional XML declaration, comments and doctype. */
const SVG_START = /^\s*(?:<\?xml[^>]*\?>\s*)?(?:<!--[\s\S]*?-->\s*)*(?:<!DOCTYPE[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg[\s>]/i;

/** SVG size as resvg reads it: width and height, else the viewBox. Null when resvg cannot parse it. */
async function svgSize(bytes: Uint8Array): Promise<{ width: number; height: number } | null> {
	let text: string;
	try {
		text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
	} catch {
		return null;
	}
	if (!SVG_START.test(text)) return null;
	await ready();
	try {
		const resvg = new Resvg(text);
		const size = { width: resvg.width, height: resvg.height };
		resvg.free();
		return size;
	} catch {
		return null;
	}
}

/**
 * A logo's bytes as a ticket image: PNG, JPEG or SVG told by the bytes themselves, never by the
 * declared content type, and at most LOGO_MAX_SIDE px on either side. Anything else is null, and
 * the ticket shows the organization's name.
 */
export async function readTicketImage(bytes: Uint8Array): Promise<TicketImage | null> {
	const [contentType, size] = startsWith(bytes, PNG_SIGNATURE)
		? (['image/png', endsWith(bytes, PNG_END) ? pngSize(bytes) : null] as const)
		: startsWith(bytes, [0xff, 0xd8, 0xff])
			? (['image/jpeg', endsWith(bytes, JPEG_END) ? jpegSize(bytes) : null] as const)
			: (['image/svg+xml', await svgSize(bytes)] as const);
	if (!size || size.width < 1 || size.height < 1 || size.width > LOGO_MAX_SIDE || size.height > LOGO_MAX_SIDE) return null;
	return { contentType, bytes };
}

export interface TicketBrand {
	readonly name: string;
	/** The palette of the theme's default mode, contrast already checked (resolveTheme). */
	readonly palette: Palette;
	readonly fontDisplay: FontFamily;
	readonly fontBody: FontFamily;
	readonly radius: number;
	readonly logo: TicketImage | null;
	/** The site's host, e.g. `tallerdemo.example`. */
	readonly site: string;
}

export interface TicketView {
	readonly brand: TicketBrand;
	readonly campaign: string;
	readonly firstName: string;
	readonly reference: string;
	readonly numbers: readonly number[];
	readonly entryDigits: number;
	readonly drawAt: Date | null;
	readonly timezone: string;
}

/** What a ticket may show of an order: its reference and the buyer's first name, nothing else. */
export function ticketView(input: {
	brand: TicketBrand;
	campaign: { title: string; entryDigits: number; drawAt: Date | null; timezone: string };
	order: { reference: string; buyer: { firstName: string } };
	numbers: readonly number[];
}): TicketView {
	return {
		brand: input.brand,
		campaign: input.campaign.title,
		firstName: input.order.buyer.firstName,
		reference: input.order.reference,
		numbers: [...input.numbers],
		entryDigits: input.campaign.entryDigits,
		drawAt: input.campaign.drawAt,
		timezone: input.campaign.timezone
	};
}

const require = createRequire(import.meta.url);

/** Static TTF builds of the theme fonts (fontFamilies); `system` has no file, so it uses Inter Tight. */
const FONTS: Record<FontFamily, { family: string; regular: string; bold: string }> = {
	archivo: { family: 'Archivo', regular: '@expo-google-fonts/archivo/400Regular/Archivo_400Regular.ttf', bold: '@expo-google-fonts/archivo/700Bold/Archivo_700Bold.ttf' },
	'big-shoulders': {
		family: 'Big Shoulders',
		regular: '@expo-google-fonts/big-shoulders/400Regular/BigShoulders_400Regular.ttf',
		bold: '@expo-google-fonts/big-shoulders/700Bold/BigShoulders_700Bold.ttf'
	},
	'inter-tight': {
		family: 'Inter Tight',
		regular: '@expo-google-fonts/inter-tight/400Regular/InterTight_400Regular.ttf',
		bold: '@expo-google-fonts/inter-tight/700Bold/InterTight_700Bold.ttf'
	},
	system: {
		family: 'Inter Tight',
		regular: '@expo-google-fonts/inter-tight/400Regular/InterTight_400Regular.ttf',
		bold: '@expo-google-fonts/inter-tight/700Bold/InterTight_700Bold.ttf'
	}
};

let wasm: Promise<void> | undefined;
function ready(): Promise<void> {
	wasm ??= initWasm(readFileSync(require.resolve('@resvg/resvg-wasm/index_bg.wasm'))).catch((error: unknown) => {
		wasm = undefined;
		throw error;
	});
	return wasm;
}

const fontFiles = new Map<string, Uint8Array>();
function fontBuffers(brand: TicketBrand): Uint8Array[] {
	const paths = new Set([brand.fontDisplay, brand.fontBody].flatMap((font) => [FONTS[font].regular, FONTS[font].bold]));
	return [...paths].map((path) => {
		let file = fontFiles.get(path);
		if (!file) {
			file = new Uint8Array(readFileSync(require.resolve(path)));
			fontFiles.set(path, file);
		}
		return file;
	});
}

const escape = (value: string) =>
	value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);

const chances = (count: number) => (count === 1 ? '1 chance' : `${count} chances`);

/** "sábado 12 de diciembre de 2026, 21:00 h", in the campaign's time zone. */
export function ticketDrawDate(at: Date, timezone: string): string {
	const parts = Object.fromEntries(
		new Intl.DateTimeFormat('es-AR', { timeZone: timezone, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
			.formatToParts(at)
			.map((part) => [part.type, part.value])
	);
	return `${parts.weekday} ${parts.day} de ${parts.month} de ${parts.year}, ${parts.hour}:${parts.minute} h`;
}

interface TextStyle {
	readonly font: FontFamily;
	readonly size: number;
	readonly bold?: boolean;
	readonly spacing?: number;
}

type Measure = (text: string, style: TextStyle) => number;

/** Text width as resvg lays it out, so lines wrap where the rendered text really ends. */
function measurer(options: ConstructorParameters<typeof Resvg>[1]): Measure {
	const cache = new Map<string, number>();
	return (text, style) => {
		const key = `${style.font}|${style.size}|${style.bold ? 1 : 0}|${style.spacing ?? 0}|${text}`;
		const known = cache.get(key);
		if (known !== undefined) return known;
		const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="8000" height="${style.size * 3}">${textElement(text, 0, style.size * 2, style, '#000')}</svg>`;
		const resvg = new Resvg(svg, options);
		const box = resvg.getBBox();
		// Where the ink ends from the text's x, side bearing included.
		const width = box ? box.x + box.width : 0;
		box?.free();
		resvg.free();
		cache.set(key, width);
		return width;
	};
}

function textElement(text: string, x: number, y: number, style: TextStyle, fill: string, anchor: 'start' | 'middle' = 'start'): string {
	const spacing = style.spacing ? ` letter-spacing="${style.spacing}"` : '';
	const middle = anchor === 'middle' ? ' text-anchor="middle"' : '';
	return `<text x="${x}" y="${y}" font-family="${FONTS[style.font].family}" font-size="${style.size}" font-weight="${style.bold ? 700 : 400}"${spacing}${middle} fill="${fill}">${escape(text)}</text>`;
}

const graphemes = new Intl.Segmenter('es', { granularity: 'grapheme' });
const characters = (text: string) => [...graphemes.segment(text)].map((part) => part.segment);

/** A word wider than the box, broken into pieces that each fit; other words stay whole. */
function breakWord(word: string, width: number, style: TextStyle, measure: Measure): string[] {
	if (measure(word, style) <= width) return [word];
	const pieces: string[] = [];
	let piece = '';
	for (const character of characters(word)) {
		if (piece && measure(piece + character, style) > width) {
			pieces.push(piece);
			piece = character;
		} else piece += character;
	}
	if (piece) pieces.push(piece);
	return pieces;
}

/** `text` shortened with an ellipsis until it fits with `suffix` after it; whole when it already fits. */
function ellipsize(text: string, width: number, style: TextStyle, measure: Measure, suffix = ''): string {
	if (measure(`${text}${suffix}`, style) <= width) return `${text}${suffix}`;
	const kept = characters(text);
	while (kept.length > 1 && measure(`${kept.join('').trimEnd()}…${suffix}`, style) > width) kept.pop();
	return `${kept.join('').trimEnd()}…${suffix}`;
}

/** Greedy word wrap to `width`, breaking words too long for a line; a last line that does not fit ends in an ellipsis. */
function wrap(text: string, width: number, style: TextStyle, measure: Measure, maxLines: number): string[] {
	const lines: string[] = [];
	let line = '';
	for (const word of text.split(/\s+/).filter(Boolean).flatMap((each) => breakWord(each, width, style, measure))) {
		const candidate = line ? `${line} ${word}` : word;
		if (!line || measure(candidate, style) <= width) {
			line = candidate;
			continue;
		}
		lines.push(line);
		line = word;
	}
	if (line) lines.push(line);
	if (lines.length <= maxLines && lines.every((each) => measure(each, style) <= width)) return lines;
	const kept = lines.slice(0, maxLines);
	// Lines left out: the last one kept says so.
	const last = kept[kept.length - 1]!;
	kept[kept.length - 1] = measure(`${last}…`, style) <= width ? `${last}…` : ellipsize(last, width, style, measure);
	return kept;
}

/** The largest size from `sizes` at which `text` fits in `maxLines`, or the smallest, truncated. */
function fit(text: string, width: number, base: Omit<TextStyle, 'size'>, sizes: readonly number[], measure: Measure, maxLines: number) {
	for (const size of sizes) {
		const style = { ...base, size };
		const lines = wrap(text, width, style, measure, maxLines + 1);
		if (lines.length <= maxLines) return { style, lines };
	}
	const style = { ...base, size: sizes[sizes.length - 1]! };
	return { style, lines: wrap(text, width, style, measure, maxLines) };
}

const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');

/** What one render draws: the logo or not, and how many coupons before the rest are counted. */
interface Layout {
	readonly withLogo: boolean;
	readonly maxNumbers: number;
}

async function buildSvg(view: TicketView, layout: Layout): Promise<{ svg: string; options: ConstructorParameters<typeof Resvg>[1] }> {
	await ready();
	const { brand } = view;
	const p = brand.palette;
	const options = { fitTo: { mode: 'original' as const }, font: { fontBuffers: fontBuffers(brand), defaultFontFamily: FONTS[brand.fontBody].family } };
	const measure = measurer(options);
	const display = (size: number, bold = true): TextStyle => ({ font: brand.fontDisplay, size, bold });
	const body = (size: number, bold = false, spacing?: number): TextStyle => ({ font: brand.fontBody, size, bold, ...(spacing ? { spacing } : {}) });

	const W = TICKET_WIDTH;
	const edge = 40;
	const pad = 56;
	const x0 = edge + pad;
	const width = W - 2 * (edge + pad);
	const radius = Math.min(48, Math.max(8, brand.radius * 2));
	const parts: string[] = [];
	let y = edge + 16 + 64;

	// Brand: the published logo, or the organization's name.
	const logo = layout.withLogo ? brand.logo : null;
	if (logo) {
		parts.push(`<image x="${x0}" y="${y}" width="${Math.min(480, width)}" height="128" preserveAspectRatio="xMinYMid meet" href="data:${logo.contentType};base64,${base64(logo.bytes)}"/>`);
		y += 128;
	} else {
		const name = fit(brand.name, width, { font: brand.fontDisplay, bold: true }, [64, 52, 44], measure, 2);
		for (const line of name.lines) {
			y += name.style.size;
			parts.push(textElement(line, x0, y, name.style, p.text));
			y += name.style.size * 0.12;
		}
	}
	y += 36;
	parts.push(`<rect x="${x0}" y="${y}" width="120" height="10" rx="5" fill="${p.accent}"/>`);
	y += 10 + 56;

	// Campaign and buyer.
	const eyebrow = body(28, true, 4);
	y += eyebrow.size;
	parts.push(textElement('TUS CHANCES PARA', x0, y, eyebrow, p.accent));
	y += 24;
	const title = fit(view.campaign, width, { font: brand.fontDisplay, bold: true }, [88, 76, 64, 56], measure, 3);
	for (const line of title.lines) {
		y += title.style.size;
		parts.push(textElement(line, x0, y, title.style, p.text));
		y += title.style.size * 0.1;
	}
	y += 40;
	// A long first name is shortened, never the number of chances.
	const greeting = ellipsize(view.firstName.trim(), width, body(38, true), measure, ` · ${chances(view.numbers.length)}`);
	y += 38;
	parts.push(textElement(greeting, x0, y, body(38, true), p.muted));
	y += 48;

	// Coupons, as chips in a grid.
	const shown = view.numbers.slice(0, layout.maxNumbers);
	// Up to nine coupons get big chips; longer lists get compact ones, so the image stays small.
	const compact = shown.length > 9;
	const chipText = display(compact ? 40 : 52);
	const labels = shown.map((number) => formatEntryNumber(number, view.entryDigits));
	const widest = Math.max(...labels.map((label) => measure(label, chipText)));
	const gap = compact ? 16 : 20;
	const columns = Math.max(1, Math.min(5, Math.floor((width + gap) / (widest + 56 + gap))));
	const chipWidth = (width - gap * (columns - 1)) / columns;
	const chipHeight = compact ? 72 : 96;
	labels.forEach((label, index) => {
		const column = index % columns;
		const row = Math.floor(index / columns);
		const cx = x0 + column * (chipWidth + gap);
		const cy = y + row * (chipHeight + gap);
		parts.push(`<rect x="${cx}" y="${cy}" width="${chipWidth}" height="${chipHeight}" rx="${Math.min(radius, 24)}" fill="${p.surface2}" stroke="${p.accent}" stroke-width="3"/>`);
		parts.push(textElement(label, cx + chipWidth / 2, cy + chipHeight / 2 + chipText.size * 0.36, chipText, p.text, 'middle'));
	});
	y += Math.ceil(labels.length / columns) * (chipHeight + gap) - gap;
	const more = view.numbers.length - shown.length;
	if (more > 0) {
		y += 30 + 16;
		parts.push(textElement(`y ${chances(more)} más: las ves todas en el email y en Consultar`, x0, y, body(30), p.muted));
	}
	y += 64;

	// Perforation between the ticket and its stub.
	const perforation = y;
	y += 64;

	// Stub: reference, draw date and site.
	const label = body(24, true, 3);
	y += label.size;
	parts.push(textElement('COMPROBANTE', x0, y, label, p.muted));
	y += 12 + 52;
	parts.push(textElement(view.reference, x0, y, display(56), p.text));
	if (view.drawAt) {
		y += 48 + label.size;
		parts.push(textElement('FECHA DEL SORTEO', x0, y, label, p.muted));
		for (const line of wrap(ticketDrawDate(view.drawAt, view.timezone), width, body(36, true), measure, 2)) {
			y += 12 + 36;
			parts.push(textElement(line, x0, y, body(36, true), p.text));
		}
	}
	y += 56;
	for (const line of wrap(brand.site, width, body(34, true), measure, 2)) {
		y += 34;
		parts.push(textElement(line, x0, y, body(34, true), p.accent));
		y += 8;
	}
	y -= 8;
	for (const line of wrap(`Guardá esta imagen. Los cupones que valen son los registrados en ${brand.site}, donde podés consultarlos.`, width, body(26), measure, 3)) {
		y += 14 + 26;
		parts.push(textElement(line, x0, y, body(26), p.muted));
	}
	const H = Math.ceil(y + pad + edge);

	const svg = [
		`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`,
		`<title>${escape(brand.name)}</title>`,
		`<rect width="${W}" height="${H}" fill="${p.bg}"/>`,
		`<clipPath id="ticket"><rect x="${edge}" y="${edge}" width="${W - 2 * edge}" height="${H - 2 * edge}" rx="${radius}"/></clipPath>`,
		`<rect x="${edge}" y="${edge}" width="${W - 2 * edge}" height="${H - 2 * edge}" rx="${radius}" fill="${p.surface}" stroke="${p.border}" stroke-width="2"/>`,
		`<rect x="${edge}" y="${edge}" width="${W - 2 * edge}" height="16" fill="${p.accent}" clip-path="url(#ticket)"/>`,
		`<line x1="${edge + 44}" y1="${perforation}" x2="${W - edge - 44}" y2="${perforation}" stroke="${p.border}" stroke-width="4" stroke-dasharray="16 12"/>`,
		`<circle cx="${edge}" cy="${perforation}" r="30" fill="${p.bg}"/>`,
		`<circle cx="${W - edge}" cy="${perforation}" r="30" fill="${p.bg}"/>`,
		...parts,
		'</svg>'
	].join('');
	return { svg, options };
}

/** The ticket's SVG source, with the logo when there is one. */
export async function ticketSvg(view: TicketView): Promise<string> {
	return (await buildSvg(view, LAYOUTS[0]!)).svg;
}

function rasterize(svg: string, options: ConstructorParameters<typeof Resvg>[1]): Uint8Array {
	const resvg = new Resvg(svg, options);
	const image = resvg.render();
	const png = image.asPng();
	image.free();
	resvg.free();
	return png;
}

/**
 * Renders tried in order until one fits the size budget: the full ticket, then without the logo,
 * then with fewer coupons drawn (the rest are counted). The last one is within the budget in the
 * worst case of every theme font (ticket.test.ts).
 */
const LAYOUTS: readonly Layout[] = [
	{ withLogo: true, maxNumbers: TICKET_MAX_NUMBERS },
	{ withLogo: false, maxNumbers: TICKET_MAX_NUMBERS },
	{ withLogo: false, maxNumbers: 24 },
	{ withLogo: false, maxNumbers: 12 }
];

/** The ticket as a PNG, within TICKET_MAX_BYTES: a render over the budget is redone smaller (LAYOUTS). */
export async function renderTicket(view: TicketView): Promise<Uint8Array> {
	const layouts = view.brand.logo ? LAYOUTS : LAYOUTS.slice(1);
	let png: Uint8Array | undefined;
	for (const layout of layouts) {
		const { svg, options } = await buildSvg(view, layout);
		png = rasterize(svg, options);
		if (png.byteLength <= TICKET_MAX_BYTES) break;
	}
	return png!;
}
