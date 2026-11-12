/**
 * The files a digital product delivers (FR-COM-05): private, served only
 * through signed, expiring download grants, one per file. The kind is decided
 * by the file's first bytes, never by its name or declared type. Images are
 * accepted besides PDF and ZIP because a ZIP is hard to open on a phone
 * (owner-feedback-2026-11-11b, S2): the buyer gets each image directly.
 */

export const productFileKinds = [
	{ extension: 'pdf', extensions: ['pdf'], contentType: 'application/pdf', label: 'a PDF', magic: [0x25, 0x50, 0x44, 0x46, 0x2d] },
	{ extension: 'zip', extensions: ['zip'], contentType: 'application/zip', label: 'a ZIP', magic: [0x50, 0x4b, 0x03, 0x04] },
	{ extension: 'png', extensions: ['png'], contentType: 'image/png', label: 'a PNG image', magic: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
	{ extension: 'jpg', extensions: ['jpg', 'jpeg'], contentType: 'image/jpeg', label: 'a JPEG image', magic: [0xff, 0xd8, 0xff] }
] as const;

export type ProductFileKind = (typeof productFileKinds)[number];
export type ProductFileContentType = ProductFileKind['contentType'];

/** The kinds, as the messages name them. */
export const productFileKindsLabel = 'a PDF, ZIP, PNG or JPEG';

/**
 * Largest file the back office uploads, like a site video (VIDEO_MAX_BYTES): the web and the API
 * hold it in memory once. `pnpm db:product-file` and client packs have no limit.
 */
export const PRODUCT_FILE_MAX_BYTES = 50 * 1024 * 1024;

/** Files of one product: each is a button in the paid email and in Consultar. */
export const PRODUCT_FILES_MAX = 10;

// Plain ASCII, so the name survives Content-Disposition and every mail client unchanged.
export const safeProductFilename = /^[A-Za-z0-9][A-Za-z0-9._-]{0,150}$/;
const MAX_NAME_LENGTH = 151;

export function sniffProductFile(bytes: Uint8Array): ProductFileKind | null {
	return productFileKinds.find((kind) => kind.magic.every((byte, index) => bytes[index] === byte)) ?? null;
}

export function productFileKindOf(contentType: string): ProductFileKind | undefined {
	return productFileKinds.find((kind) => kind.contentType === contentType);
}

/** Whether the download name ends with an extension of its kind (`.jpg` or `.jpeg` for a JPEG), in any case. */
export function hasProductFileExtension(filename: string, kind: ProductFileKind): boolean {
	const lower = filename.toLowerCase();
	return kind.extensions.some((extension) => lower.endsWith(`.${extension}`));
}

/**
 * A safe download name from the name of the chosen file ("Guía de motos.pdf" →
 * "Guia-de-motos.pdf"): accents dropped, spaces as dashes, anything else
 * outside A-Z, digits, dots, dashes and underscores removed.
 */
export function productDownloadName(name: string): string {
	const plain = name.trim().normalize('NFD').replace(/\p{M}/gu, '');
	const dot = plain.lastIndexOf('.');
	const extension = dot > 0 ? `.${plain.slice(dot + 1).replace(/[^A-Za-z0-9]/g, '')}` : '';
	const base =
		(dot > 0 ? plain.slice(0, dot) : plain)
			.replace(/\s+/g, '-')
			.replace(/[^A-Za-z0-9._-]/g, '')
			.replace(/-{2,}/g, '-')
			.replace(/^[^A-Za-z0-9]+/, '')
			.replace(/[-.]+$/, '') || 'archivo';
	const suffix = extension.length > 1 ? extension : '';
	return `${base.slice(0, MAX_NAME_LENGTH - suffix.length)}${suffix}`;
}

/**
 * The download name of an uploaded file: `productDownloadName`, ending with the extension of what
 * its bytes are ("Fondo.jpg" holding a PNG becomes "Fondo.png"), so the buyer's phone opens it.
 */
export function fitProductDownloadName(name: string, kind: ProductFileKind): string {
	const safe = productDownloadName(name);
	if (hasProductFileExtension(safe, kind)) return safe;
	const base = safe.replace(/\.[A-Za-z0-9]{1,5}$/, '') || 'archivo';
	return `${base.slice(0, MAX_NAME_LENGTH - kind.extension.length - 1)}.${kind.extension}`;
}
