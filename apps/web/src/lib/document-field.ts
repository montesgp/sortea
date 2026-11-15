import { documentTypes, normalizeDocument, type DocumentType } from '@sortea/domain';

/**
 * The document number field of checkout and Consultar (owner-feedback-2026-11-12, S5): per type, an
 * example and a short format hint matching what `normalizeDocument` accepts, and a keyboard that fits.
 */
export interface DocumentField {
	type: DocumentType;
	label: string;
	placeholder: string;
	hint: string;
	inputmode: 'numeric' | 'text';
	autocapitalize?: 'characters';
}

const fields: Record<DocumentType, Omit<DocumentField, 'type'>> = {
	DNI: { label: 'DNI', placeholder: 'Ej.: 30123456', hint: '7 u 8 números, sin puntos.', inputmode: 'numeric' },
	// A mask, not a number: a valid CUIT would belong to someone.
	CUIT: { label: 'CUIT', placeholder: 'Ej.: 20XXXXXXXXX', hint: '11 números, sin guiones: prefijo, DNI y dígito verificador.', inputmode: 'numeric' },
	PASSPORT: { label: 'Pasaporte', placeholder: 'Ej.: AAA123456', hint: 'Letras y números, sin espacios.', inputmode: 'text', autocapitalize: 'characters' }
};

export const documentFields: readonly DocumentField[] = documentTypes.map((type) => ({ type, ...fields[type] }));

/** The field for a submitted type; anything else is the default, DNI. */
export function documentField(type: string | undefined): DocumentField {
	return documentFields.find((field) => field.type === type) ?? documentFields[0]!;
}

export interface DocumentCheck {
	label: string;
	ok: boolean;
}

/**
 * The requirements of the number for its type, each ticked while it is typed (owner feedback
 * 2026-11-15 S8), and whether the number is valid: valid is exactly what `normalizeDocument`, the
 * server's rule, accepts, so a fully ticked list is never refused on submit.
 */
export function documentChecks(type: string, raw: string): { checks: DocumentCheck[]; valid: boolean } {
	const field = documentField(type);
	const digits = raw.replace(/[\s.\-]/g, '');
	const valid = normalizeDocument(field.type, raw).ok;
	switch (field.type) {
		case 'DNI':
			return { checks: [{ label: '7 u 8 números', ok: /^\d{7,8}$/.test(digits) }], valid };
		case 'CUIT':
			return { checks: [{ label: '11 números', ok: /^\d{11}$/.test(digits) }, { label: 'Dígito verificador correcto', ok: valid }], valid };
		case 'PASSPORT':
			return { checks: [{ label: 'De 6 a 12 letras o números', ok: /^[A-Z0-9]{6,12}$/.test(raw.replace(/\s/g, '').toUpperCase()) }], valid };
	}
}
