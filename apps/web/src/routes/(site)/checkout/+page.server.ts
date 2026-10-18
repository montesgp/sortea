import { buyerSchema, countryCodeSchema, normalizeDocument, organizationCountry, shipsTo } from '@sortea/domain';
import { EMAIL_INVALID, EMAIL_MISMATCH, sameEmail } from '#lib/email-check.js';
import { formCountry, resolveProvince, SHIPPING_ONLY_HOME, type CountryOption, type SubdivisionOption } from '#lib/location.js';
import { fail, redirect, type RequestEvent } from '@sveltejs/kit';
import { api } from '#lib/server/api.js';
import { clearCart, readCart } from '#lib/server/cart.js';
import { saveReceipt } from '#lib/server/receipt.js';
import type { Quote } from '#lib/server/types.js';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
	const cart = readCart(event.cookies);
	if (cart.lines.length === 0) redirect(303, '/carrito');
	const [quote, countries, subdivisions] = await Promise.all([
		api<Quote>(event, '/checkout/quote', { method: 'POST', body: { lines: cart.lines, deliveryMethod: 'digital' } }),
		api<{ countries: CountryOption[] }>(event, '/geo/countries'),
		subdivisionsOf(event, organizationCountry)
	]);
	if (!quote.ok || !quote.data.ok) redirect(303, '/carrito');
	// Without the reference data the fields are plain text inputs: the buyer can still type them (S7).
	return { quote: quote.data, countries: countries.ok ? countries.data.countries.map((country) => country.code) : [], subdivisions };
};

/** The country's subdivisions, or none when it has none listed (or the data is unavailable). */
async function subdivisionsOf(event: RequestEvent, country: string): Promise<SubdivisionOption[]> {
	// The country comes from the form: only a code may become part of the API path.
	const code = countryCodeSchema.safeParse(country);
	if (!code.success) return [];
	const result = await api<{ subdivisions: SubdivisionOption[] }>(event, `/geo/countries/${code.data}/subdivisions`);
	return result.ok ? result.data.subdivisions : [];
}

type Values = Record<string, string>;

export const actions: Actions = {
	default: async (event) => {
		const form = await event.request.formData();
		const values: Values = Object.fromEntries([...form.entries()].map(([key, value]) => [key, String(value)]));
		const errors: Record<string, string> = {};
		const country = formCountry(values.country);
		// After a failed submit the province list must be the buyer's country's, also without JavaScript.
		const failure = async (status: number, data: { errors: Record<string, string>; message: string }) =>
			fail(status, {
				values: withoutSecrets(values),
				...data,
				subdivisions: country === organizationCountry ? undefined : await subdivisionsOf(event, country)
			});

		const buyer = buyerSchema.safeParse({
			documentType: values.documentType,
			documentNumber: values.documentNumber,
			firstName: values.firstName,
			lastName: values.lastName,
			email: values.email?.trim(),
			phone: values.phone,
			country,
			province: resolveProvince(values.province, values.provinceOther),
			city: values.city
		});
		if (!buyer.success) {
			for (const issue of buyer.error.issues) errors[String(issue.path[0])] = fieldMessage(String(issue.path[0]));
		}
		if (buyer.success && !normalizeDocument(buyer.data.documentType, buyer.data.documentNumber).ok) {
			errors.documentNumber = 'Revisá el número de documento';
		}
		if (values.email && !sameEmail(values.emailConfirm ?? '', values.email)) errors.emailConfirm = EMAIL_MISMATCH;
		if (values.terms !== 'on') errors.terms = 'Necesitamos que aceptes los términos para vender';
		if (values.privacy !== 'on') errors.privacy = 'Necesitamos que leas la política de privacidad';
		const method = values.deliveryMethod || 'digital';
		if (method === 'shipping') {
			for (const field of ['street', 'postalCode']) if (!values[field]?.trim()) errors[field] = 'Completá este dato';
		}
		if (method === 'shipping' && !shipsTo(country)) {
			// Without JavaScript the shipping option is not disabled when the country changes; say why here,
			// together with any other field to fix.
			return failure(400, { errors, message: `${SHIPPING_ONLY_HOME}. Elegí retiro o cambiá el país` });
		}
		if (Object.keys(errors).length || !buyer.success) return failure(400, { errors, message: 'Revisá los datos marcados' });

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
		if (!result.ok) return failure(result.status === 409 ? 409 : 400, { errors: {}, message: result.message });

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
		email: EMAIL_INVALID,
		phone: 'Revisá el teléfono',
		country: 'Elegí tu país',
		province: 'Elegí tu provincia',
		city: 'Ingresá tu ciudad'
	};
	return messages[field] ?? 'Revisá este dato';
}
