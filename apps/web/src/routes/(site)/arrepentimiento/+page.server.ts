import { fail } from '@sveltejs/kit';
import { readWithdrawalRequest, withdrawalHref } from '#lib/withdrawal.js';
import type { Actions } from './$types';

// The no-JavaScript path: the page answers with the prepared WhatsApp link to
// open. A POST keeps the buyer's name out of URLs and access logs, and the
// answer is a link rather than a redirect because the site's CSP `form-action`
// does not allow a form to land on wa.me.
export const actions: Actions = {
	default: async ({ request, locals }) => {
		const form = await request.formData();
		const read = readWithdrawalRequest({ reference: form.get('reference')?.toString(), name: form.get('name')?.toString() });
		if (!read.ok) return fail(400, { values: read.values, errors: read.errors, href: null });
		// Null when there is no number: the page then shows the other channels.
		return { values: read.values, errors: {}, href: withdrawalHref(locals.site?.contact.whatsapp, read.values) };
	}
};
