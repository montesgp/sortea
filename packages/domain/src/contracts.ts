import { z } from 'zod';
import { documentTypes } from './identity';

/** Request contracts shared by the web BFF and the API. */
export const cartLineSchema = z.object({
	variantId: z.uuid(),
	quantity: z.number().int().min(1).max(20)
});

export const deliveryMethods = ['digital', 'pickup', 'shipping'] as const;

export const addressSchema = z.object({
	street: z.string().trim().min(3).max(120),
	city: z.string().trim().min(2).max(80),
	province: z.string().trim().min(2).max(80),
	postalCode: z.string().trim().min(3).max(10)
});

/** The 24 Argentine jurisdictions, as the buyer picks them at checkout (S7). */
export const argentineProvinces = [
	'Buenos Aires',
	'Ciudad Autónoma de Buenos Aires',
	'Catamarca',
	'Chaco',
	'Chubut',
	'Córdoba',
	'Corrientes',
	'Entre Ríos',
	'Formosa',
	'Jujuy',
	'La Pampa',
	'La Rioja',
	'Mendoza',
	'Misiones',
	'Neuquén',
	'Río Negro',
	'Salta',
	'San Juan',
	'San Luis',
	'Santa Cruz',
	'Santa Fe',
	'Santiago del Estero',
	'Tierra del Fuego',
	'Tucumán'
] as const;
export type ArgentineProvince = (typeof argentineProvinces)[number];

export const buyerSchema = z.object({
	documentType: z.enum(documentTypes),
	documentNumber: z.string().trim().min(5).max(20),
	firstName: z.string().trim().min(1).max(80),
	lastName: z.string().trim().min(1).max(80),
	email: z.email().max(160),
	phone: z
		.string()
		.trim()
		.regex(/^\+?[\d\s\-()]{8,20}$/, 'Teléfono inválido')
		.optional()
		.or(z.literal('').transform(() => undefined)),
	/** Where the buyer lives, asked on every checkout; shipping goes to this city and province. */
	province: z.enum(argentineProvinces),
	city: z.string().trim().min(2).max(80)
});

export const consentsSchema = z.object({
	/** Terms of sale: required to buy. */
	terms: z.literal(true),
	/** Privacy policy acknowledgement: required to buy. */
	privacy: z.literal(true),
	/** Marketing by email: optional, never pre-selected (FR-COM-06). */
	marketingEmail: z.boolean()
});

export const checkoutRequestSchema = z
	.object({
		lines: z.array(cartLineSchema).min(1).max(20),
		buyer: buyerSchema,
		delivery: z.object({
			method: z.enum(deliveryMethods),
			address: addressSchema.optional()
		}),
		consents: consentsSchema,
		campaignSlug: z.string().max(80).optional()
	})
	.superRefine((value, ctx) => {
		if (value.delivery.method !== 'shipping') return;
		const { address } = value.delivery;
		if (!address) {
			ctx.addIssue({ code: 'custom', message: 'Shipping requires an address', path: ['delivery', 'address'] });
			return;
		}
		// Shipping goes to the city and province the buyer gave (S7); the web fills them from the buyer.
		if (address.city !== value.buyer.city) ctx.addIssue({ code: 'custom', message: 'Shipping goes to the buyer city', path: ['delivery', 'address', 'city'] });
		if (address.province !== value.buyer.province) {
			ctx.addIssue({ code: 'custom', message: 'Shipping goes to the buyer province', path: ['delivery', 'address', 'province'] });
		}
	});
export type CheckoutRequest = z.infer<typeof checkoutRequestSchema>;

export const lookupStartSchema = z.object({
	documentType: z.enum(documentTypes),
	documentNumber: z.string().trim().min(5).max(20)
});

export const lookupVerifySchema = z.object({
	challengeId: z.uuid(),
	code: z.string().trim().regex(/^\d{6}$/, 'El código tiene 6 dígitos')
});

export const receiptLookupSchema = z.object({
	reference: z.string().trim().regex(/^[A-Z0-9-]{6,24}$/),
	accessCode: z.string().trim().regex(/^[A-Z0-9]{10}$/)
});
