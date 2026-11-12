import { describe, expect, it } from 'vitest';
import {
	fitProductDownloadName,
	hasProductFileExtension,
	PRODUCT_FILE_MAX_BYTES,
	PRODUCT_FILES_MAX,
	productDownloadName,
	productFileKindOf,
	productFileKinds,
	safeProductFilename,
	sniffProductFile
} from '../src';

// Owner feedback 2026-11-11b, S2: a ZIP is hard to open on a phone, so a digital product
// delivers its images directly, one download link per file.

const bytes = (...values: number[]) => new Uint8Array([...values, 0x00, 0x01]);
const pdf = new TextEncoder().encode('%PDF-1.7\n%%EOF\n');
const zip = bytes(0x50, 0x4b, 0x03, 0x04);
const png = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
const jpeg = bytes(0xff, 0xd8, 0xff, 0xe0);

describe('sniffProductFile', () => {
	it('recognizes PDF, ZIP, PNG and JPEG by their first bytes', () => {
		expect(sniffProductFile(pdf)).toMatchObject({ contentType: 'application/pdf', extension: 'pdf' });
		expect(sniffProductFile(zip)).toMatchObject({ contentType: 'application/zip', extension: 'zip' });
		expect(sniffProductFile(png)).toMatchObject({ contentType: 'image/png', extension: 'png' });
		expect(sniffProductFile(jpeg)).toMatchObject({ contentType: 'image/jpeg', extension: 'jpg' });
	});

	it('refuses anything else, whatever its name says', () => {
		expect(sniffProductFile(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
		expect(sniffProductFile(bytes(0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50))).toBeNull();
		expect(sniffProductFile(bytes(0x89, 0x50, 0x4e, 0x47))).toBeNull();
		expect(sniffProductFile(new Uint8Array())).toBeNull();
	});
});

describe('product file names', () => {
	it('match the content: .jpg or .jpeg for a JPEG, in any case', () => {
		const kind = (contentType: string) => productFileKindOf(contentType)!;
		expect(hasProductFileExtension('Fondo.png', kind('image/png'))).toBe(true);
		expect(hasProductFileExtension('Fondo.PNG', kind('image/png'))).toBe(true);
		expect(hasProductFileExtension('Foto.jpg', kind('image/jpeg'))).toBe(true);
		expect(hasProductFileExtension('Foto.jpeg', kind('image/jpeg'))).toBe(true);
		expect(hasProductFileExtension('Foto.png', kind('image/jpeg'))).toBe(false);
		expect(hasProductFileExtension('Guia.pdf', kind('application/pdf'))).toBe(true);
		expect(hasProductFileExtension('Guia.zip', kind('application/pdf'))).toBe(false);
		expect(productFileKindOf('image/webp')).toBeUndefined();
	});

	it('stay plain ASCII so they survive Content-Disposition and mail clients', () => {
		expect(safeProductFilename.test('TallerDemo-calcomania.png')).toBe(true);
		expect(safeProductFilename.test('Guía de motos.pdf')).toBe(false);
		expect(safeProductFilename.test('-oculto.png')).toBe(false);
	});

	it('turns a name from the phone or the desktop into a safe download name', () => {
		expect(productDownloadName('Guía de motos.pdf')).toBe('Guia-de-motos.pdf');
		expect(productDownloadName('  Calcomanía  (con borde).PNG ')).toBe('Calcomania-con-borde.PNG');
		expect(productDownloadName('foto__ñandú!!.jpeg')).toBe('foto__nandu.jpeg');
		expect(productDownloadName('-.png')).toBe('archivo.png');
		expect(productDownloadName('ünïcode')).toBe('unicode');
		const long = productDownloadName(`${'a'.repeat(300)}.png`);
		expect(long).toBe(`${'a'.repeat(147)}.png`);
		expect(safeProductFilename.test(long)).toBe(true);
	});
});

describe('fitProductDownloadName', () => {
	const kind = (contentType: string) => productFileKindOf(contentType)!;

	it('keeps a name whose extension matches the content', () => {
		expect(fitProductDownloadName('Guía de motos.pdf', kind('application/pdf'))).toBe('Guia-de-motos.pdf');
		expect(fitProductDownloadName('Foto.JPEG', kind('image/jpeg'))).toBe('Foto.JPEG');
	});

	it('gives the content its extension when the name says another kind or none', () => {
		expect(fitProductDownloadName('Fondo.jpg', kind('image/png'))).toBe('Fondo.png');
		expect(fitProductDownloadName('Calcomania', kind('image/png'))).toBe('Calcomania.png');
		expect(fitProductDownloadName('IMG_0012.HEIC', kind('image/jpeg'))).toBe('IMG_0012.jpg');
		expect(safeProductFilename.test(fitProductDownloadName(`${'b'.repeat(200)}.pdf`, kind('image/png')))).toBe(true);
	});
});

describe('limits', () => {
	it('lists the four kinds and caps panel uploads at 50 MB and ten files per product', () => {
		expect(productFileKinds.map((kind) => kind.contentType)).toEqual(['application/pdf', 'application/zip', 'image/png', 'image/jpeg']);
		expect(PRODUCT_FILE_MAX_BYTES).toBe(50 * 1024 * 1024);
		expect(PRODUCT_FILES_MAX).toBe(10);
	});
});
