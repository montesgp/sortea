import { fromLocalInput } from './tz.js';

/**
 * The "Nueva campaña" form (S5, owner feedback 2026-11-10): what the admin
 * typed, kept to fill the form again, and the body of POST /admin/campaigns.
 * Dates are typed in the campaign time zone and may stay empty in a draft.
 * The API validates everything; this only turns the form into its shape.
 */
export const newCampaignFields = ['title', 'slug', 'subtitle', 'summary', 'timezone', 'opensAt', 'closesAt', 'drawAt', 'seoTitle', 'seoDescription', 'minAge', 'residency', 'rulesMarkdown'] as const;
export type NewCampaignField = (typeof newCampaignFields)[number] | 'chancesPerProduct';

export interface NewCampaignForm {
	values: Record<(typeof newCampaignFields)[number], string> & { chances: Record<string, string> };
	errors: Partial<Record<NewCampaignField, string>>;
	body: Record<string, unknown> | null;
}

const DATE_FIELDS = ['opensAt', 'closesAt', 'drawAt'] as const;

export function newCampaignFromForm(form: FormData): NewCampaignForm {
	const text = (key: string) => String(form.get(key) ?? '').trim();
	const chances: Record<string, string> = {};
	for (const [key, value] of form.entries()) if (key.startsWith('chances.')) chances[key.slice('chances.'.length)] = String(value).trim();
	const values = { ...(Object.fromEntries(newCampaignFields.map((field) => [field, text(field)])) as Record<(typeof newCampaignFields)[number], string>), chances };
	const errors: NewCampaignForm['errors'] = {};

	const dates: Record<string, string | null> = {};
	for (const field of DATE_FIELDS) {
		if (!values[field]) dates[field] = null;
		else {
			dates[field] = fromLocalInput(values[field], values.timezone);
			if (!dates[field]) errors[field] = 'Ingresá una fecha válida';
		}
	}
	const minAge = Number(values.minAge || '18');
	if (!Number.isInteger(minAge)) errors.minAge = 'La edad mínima es un número entero';
	const chancesPerProduct: Record<string, number> = {};
	for (const [productId, value] of Object.entries(chances)) {
		const perUnit = Number(value || '0');
		if (!Number.isInteger(perUnit) || perUnit < 0 || perUnit > 100) errors.chancesPerProduct = 'Las chances por unidad son un número entero de 0 a 100';
		else if (perUnit > 0) chancesPerProduct[productId] = perUnit;
	}
	if (Object.keys(errors).length > 0) return { values, errors, body: null };
	return {
		values,
		errors,
		body: {
			title: values.title,
			slug: values.slug,
			subtitle: values.subtitle || null,
			summary: values.summary,
			timezone: values.timezone || undefined,
			...dates,
			seo: { title: values.seoTitle || undefined, description: values.seoDescription || undefined },
			eligibility: { minAge, residency: values.residency || undefined },
			chancesPerProduct,
			rulesMarkdown: values.rulesMarkdown
		}
	};
}

/**
 * The API's validation errors by form field. Nested fields come by their full
 * path (`eligibility.residency`, `seo.description`); a chance's path names its
 * product, so it lands on the chances; a bare group lands on its first field.
 */
export function newCampaignErrors(details: unknown): NewCampaignForm['errors'] {
	const fieldErrors = (details as { fieldErrors?: Record<string, string[]> } | undefined)?.fieldErrors ?? {};
	const field: Record<string, NewCampaignField> = {
		'seo.title': 'seoTitle',
		'seo.description': 'seoDescription',
		'eligibility.minAge': 'minAge',
		'eligibility.residency': 'residency',
		seo: 'seoTitle',
		eligibility: 'minAge'
	};
	const errors: NewCampaignForm['errors'] = {};
	for (const [key, messages] of Object.entries(fieldErrors)) {
		const target = field[key] ?? (key.split('.')[0] as NewCampaignField);
		if (messages[0] && !errors[target]) errors[target] = messages[0];
	}
	return errors;
}
