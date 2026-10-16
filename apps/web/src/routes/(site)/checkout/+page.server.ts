import { buyerSchema, normalizeDocument } from '@sortea/domain';
import { fail, redirect } from '@sveltejs/kit';
import { api } from '#lib/server/api.js';
import { clearCart, readCart } from '#lib/server/cart.js';
import { saveReceipt } from '#lib/server/receipt.js';
import type { Quote } from '#lib/server/types.js';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
	const cart = readCart(event.cookies);
	if (cart.lines.length === 0) redirect(303, '/carrito');
	const quote = await api<Quote>(event, '/checkout/quote', { method: 'POST', body: { lines: cart.lines, deliveryMethod: 'digital' } });
	if (!quote.ok || !quote.data.ok) redirect(303, '/carrito');
	return { quote: quote.data };
};

type Values = Record<string, string>;

export const actions: Actions = {
	default: async (event) => {
		const form = await event.request.formData();
		const values: Values = Object.fromEntries([...form.entries()].map(([key, value]) => [key, String(value)]));
		const errors: Record<string, string> = {};

		const buyer = buyerSchema.safeParse({
			documentType: values.documentType,
			documentNumber: values.documentNumber,
			firstName: values.firstName,
			lastName: values.lastName,
			email: values.email,
			phone: values.phone,
			province: values.province,
			city: values.city
		});
		if (!buyer.success) {
			for (const issue of buyer.error.issues) errors[String(issue.path[0])] = fieldMessage(String(issue.path[0]));
		}
		if (buyer.success && !normalizeDocument(buyer.data.documentType, buyer.data.documentNumber).ok) {
			errors.documentNumber = 'Revisá el número de documento';
		}
		if (values.email && values.emailConfirm !== values.email) errors.emailConfirm = 'Los emails no coinciden';
		if (values.terms !== 'on') errors.terms = 'Necesitamos que aceptes los términos para vender';
		if (values.privacy !== 'on') errors.privacy = 'Necesitamos que leas la política de privacidad';
		const method = values.deliveryMethod || 'digital';
		if (method === 'shipping') {
			for (const field of ['street', 'postalCode']) if (!values[field]?.trim()) errors[field] = 'Completá este dato';
		}
		if (Object.keys(errors).length || !buyer.success) return fail(400, { values: withoutSecrets(values), errors, message: 'Revisá los datos marcados' });

		const cart = readCart(event.cookies);
		const result = await api<{ reference: string; accessCode: string; redirectUrl: string }>(event, '/checkout/orders', {
			method: 'POST',
			body: {
				lines: cart.lines,
				buyer: buyer.data,
				delivery: {
					method,
					// Shipping goes to the city and province the buyer gave in their data (S7).
					address:
						method === 'shipping'
							? { street: values.street, city: buyer.data.city, province: buyer.data.province, postalCode: values.postalCode }
							: undefined
				},
				consents: { terms: true, privacy: true, marketingEmail: values.marketingEmail === 'on' },
				campaignSlug: cart.campaign ?? undefined
			}
		});
		if (!result.ok) return fail(result.status === 409 ? 409 : 400, { values: withoutSecrets(values), errors: {}, message: result.message });

		saveReceipt(event.cookies, { reference: result.data.reference, accessCode: result.data.accessCode });
		clearCart(event.cookies);
		redirect(303, result.data.redirectUrl);
	}
};

function withoutSecrets(values: Values): Values {
	// Consents are re-asked on error; everything else is returned to refill the form.
	const { terms: _terms, privacy: _privacy, ...rest } = values;
	return rest;
}

function fieldMessage(field: string): string {
	const messages: Record<string, string> = {
		documentNumber: 'Ingresá tu número de documento',
		firstName: 'Ingresá tu nombre',
		lastName: 'Ingresá tu apellido',
		email: 'Ingresá un email válido',
		phone: 'Revisá el teléfono',
		province: 'Elegí tu provincia',
		city: 'Ingresá tu ciudad'
	};
	return messages[field] ?? 'Revisá este dato';
}
