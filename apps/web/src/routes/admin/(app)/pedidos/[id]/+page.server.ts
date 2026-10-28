import { fail } from '@sveltejs/kit';
import { adminApi, adminLoad } from '#lib/server/admin.js';
import type { Actions, PageServerLoad } from './$types';

interface OrderDetail {
	id: string;
	reference: string;
	status: string;
	currency: string;
	subtotalMinor: number;
	deliveryFeeMinor: number;
	totalMinor: number;
	deliveryMethod: string;
	createdAt: string;
	paidAt: string | null;
	piiVisible: boolean;
	buyer: { firstName: string; lastName: string; email: string; phone: string | null; province: string | null; city: string | null; document: string | null; address: Record<string, string> | null };
	items: { name: string; kind: string; quantity: number; unitPriceMinor: number; lineTotalMinor: number }[];
	payments: { providerPaymentId: string; status: string; statusDetail: string | null; amountMinor: number; approvedAt: string | null; updatedAt: string }[];
	entries: { number: number; status: string }[];
	/** Coupon digits of the order's campaign (ADR 0014 §1). */
	entryDigits: number;
	consents: { purpose: string; granted: boolean; policyVersion: string; recordedAt: string }[];
	/** Null when the person never recorded a winner publicity decision (S5, S9). */
	winnerPublicity: { publishable: boolean; withdrawable: boolean; withdrawnAt: string | null } | null;
}

export const load: PageServerLoad = async (event) => ({ order: await adminLoad<OrderDetail>(event, `/admin/orders/${event.params.id}`) });

export const actions: Actions = {
	/** The buyer asked to withdraw the winner publicity consent (S9): a refusal for the person, for every earlier purchase. */
	withdrawPublicity: async (event) => {
		const form = await event.request.formData();
		if (form.get('confirm') !== 'yes') return fail(400, { ok: false, message: 'Confirmá que la persona pidió retirar la autorización.' });
		const result = await adminApi<{ recorded: boolean }>(event, `/admin/orders/${event.params.id}/winner-publicity/withdraw`, { method: 'POST' });
		if (!result.ok) return fail(result.status, { ok: false, message: result.message });
		return {
			ok: true,
			message: result.data.recorded
				? 'Autorización retirada: no publicamos su identidad por ninguna compra anterior a hoy.'
				: 'No había nada para retirar: su identidad ya no se publicaba.'
		};
	}
};
