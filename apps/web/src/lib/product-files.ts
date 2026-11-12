import { PRODUCT_FILE_MAX_BYTES, productFileKinds } from '@sortea/domain';

/**
 * The files of a digital product, as its back-office page manages them
 * (owner-feedback-2026-11-11b, S2): each one is a download link of its own in
 * the paid email and in Consultar. The API decides the kind by the bytes and
 * the final download name; this only prepares the request.
 */

/** What the file picker offers: the four kinds by type and by extension (phones often report no type). */
export const PRODUCT_FILE_ACCEPT = [...productFileKinds.map((kind) => kind.contentType), ...productFileKinds.flatMap((kind) => kind.extensions.map((extension) => `.${extension}`))].join(',');

const labels: Record<string, string> = { 'application/pdf': 'PDF', 'application/zip': 'ZIP', 'image/png': 'Imagen PNG', 'image/jpeg': 'Imagen JPEG' };

export function productFileKindLabel(contentType: string): string {
	return labels[contentType] ?? contentType;
}

/** The API route for a new file, or for replacing `fileId`, with the chosen and the typed names. */
export function productFileUploadPath(productId: string, chosenName: string, typedName: string, fileId?: string): string {
	const query = new URLSearchParams({ filename: chosenName.slice(0, 200) });
	if (typedName.trim()) query.set('name', typedName.trim().slice(0, 200));
	return `/admin/products/${productId}/files${fileId ? `/${fileId}` : ''}?${query}`;
}

/** The file chosen in the form's `file` field, or why it cannot be sent. */
export function chosenProductFile(form: FormData): { ok: true; file: File } | { ok: false; message: string } {
	const file = form.get('file');
	if (!(file instanceof File) || file.size === 0) return { ok: false, message: 'Elegí un archivo' };
	if (file.size > PRODUCT_FILE_MAX_BYTES) {
		return { ok: false, message: 'El archivo supera 50 MB. Para uno más grande, pedile al equipo de la plataforma que lo cargue con pnpm db:product-file' };
	}
	return { ok: true, file };
}
