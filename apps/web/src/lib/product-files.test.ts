import { PRODUCT_FILE_MAX_BYTES } from '@sortea/domain';
import { describe, expect, it } from 'vitest';
import { chosenProductFile, PRODUCT_FILE_ACCEPT, productFileKindLabel, productFileUploadPath } from './product-files';

// Owner feedback 2026-11-11b, S2: a digital product's files, one download link each, managed from its page.

describe('the files form of a product page', () => {
	it('accepts the four kinds of file a product delivers', () => {
		expect(PRODUCT_FILE_ACCEPT.split(',')).toEqual(['application/pdf', 'application/zip', 'image/png', 'image/jpeg', '.pdf', '.zip', '.png', '.jpg', '.jpeg']);
	});

	it('names each kind as people read it', () => {
		expect(productFileKindLabel('application/pdf')).toBe('PDF');
		expect(productFileKindLabel('application/zip')).toBe('ZIP');
		expect(productFileKindLabel('image/png')).toBe('Imagen PNG');
		expect(productFileKindLabel('image/jpeg')).toBe('Imagen JPEG');
		expect(productFileKindLabel('text/plain')).toBe('text/plain');
	});

	it('sends the chosen name and the typed download name to the API', () => {
		expect(productFileUploadPath('p1', 'Calcomanía con borde.png', '')).toBe('/admin/products/p1/files?filename=Calcoman%C3%ADa+con+borde.png');
		expect(productFileUploadPath('p1', 'IMG_0001.jpg', ' Fondo celular ', 'f1')).toBe('/admin/products/p1/files/f1?filename=IMG_0001.jpg&name=Fondo+celular');
		expect(productFileUploadPath('p1', `${'a'.repeat(300)}.png`, '')).toBe(`/admin/products/p1/files?filename=${'a'.repeat(200)}`);
	});

	it('takes the chosen file, refusing none, an empty one or one over 50 MB', () => {
		const form = (file?: File) => {
			const data = new FormData();
			if (file) data.set('file', file);
			return data;
		};
		const png = new File([new Uint8Array([0x89, 0x50])], 'a.png', { type: 'image/png' });
		expect(chosenProductFile(form(png))).toEqual({ ok: true, file: png });
		expect(chosenProductFile(form())).toEqual({ ok: false, message: 'Elegí un archivo' });
		expect(chosenProductFile(form(new File([], 'vacio.png')))).toEqual({ ok: false, message: 'Elegí un archivo' });
		const big = { size: PRODUCT_FILE_MAX_BYTES + 1, name: 'grande.pdf' } as File;
		Object.setPrototypeOf(big, File.prototype);
		expect(chosenProductFile({ get: () => big } as unknown as FormData)).toEqual({
			ok: false,
			message: 'El archivo supera 50 MB. Para uno más grande, pedile al equipo de la plataforma que lo cargue con pnpm db:product-file'
		});
	});
});
