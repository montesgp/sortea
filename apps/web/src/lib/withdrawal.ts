import { whatsappLink } from '@sortea/domain';

/**
 * Withdrawal button (Res. 424/2020, owner feedback 2026-10-28 S12): the buyer
 * asks to revoke a purchase through the organization's WhatsApp with a prepared
 * message. The message exists only in the link sent to WhatsApp; nothing here
 * stores or logs it.
 */

export type WithdrawalValues = { reference: string; name: string };

export type WithdrawalRequest =
	| { ok: true; values: WithdrawalValues }
	| { ok: false; values: WithdrawalValues; errors: Partial<Record<keyof WithdrawalValues, string>> };

export const NAME_MAX = 120;

// The receipt code shown at the end of the purchase: the organization prefix
// (up to 4 characters) and 8 characters, mirroring `generateOrderReference`.
const RECEIPT_CODE = /^[A-Z0-9]{1,4}-[A-Z0-9]{8}$/;

const REFERENCE_INVALID = 'Revisá el comprobante: tiene el formato XX-XXXXXXXX, como figura al terminar la compra. Si no lo tenés, dejalo vacío.';
const NAME_TOO_LONG = `Escribí tu nombre en hasta ${NAME_MAX} caracteres.`;

/** The optional receipt code and name as typed, normalized; an empty field is valid. */
export function readWithdrawalRequest(input: { reference?: string | null; name?: string | null }): WithdrawalRequest {
	const values = {
		reference: (input.reference ?? '').replace(/\s/g, '').toUpperCase(),
		name: (input.name ?? '').trim().replace(/\s+/g, ' ')
	};
	const errors: Partial<Record<keyof WithdrawalValues, string>> = {};
	if (values.reference && !RECEIPT_CODE.test(values.reference)) errors.reference = REFERENCE_INVALID;
	if (values.name.length > NAME_MAX) errors.name = NAME_TOO_LONG;
	return Object.keys(errors).length ? { ok: false, values, errors } : { ok: true, values };
}

export function withdrawalMessage({ reference, name }: WithdrawalValues): string {
	const parts = ['Hola, quiero ejercer mi derecho de arrepentimiento.'];
	if (reference) parts.push(`Pedido: ${reference}.`);
	if (name) parts.push(`Nombre: ${name}.`);
	return parts.join(' ');
}

/** Chat link with the prepared message, or null when the organization has no WhatsApp number. */
export function withdrawalHref(number: string | undefined, values: WithdrawalValues): string | null {
	return whatsappLink(number, withdrawalMessage(values));
}
