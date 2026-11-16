import { randomUUID } from 'node:crypto';
import { orderEmailSchema } from '@sortea/domain';
import { fail, redirect } from '@sveltejs/kit';
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
	/** The campaign the coupons belong to (S9, owner feedback 2026-11-11b). */
	campaignTitle: string | null;
	/** Every consent stored with the order, a `winner_publicity` decision recorded before S3 (owner-feedback-2026-11-14) included. */
	consents: { purpose: string; granted: boolean; policyVersion: string; recordedAt: string }[];
	/** Paid, with a purchase email that can be sent again (odd/tasks/checkout-two-steps.md S5). */
	resendable: boolean;
}

/** `?reenvio=listo` is where a resend lands: the notice survives the redirect, and a reload sends nothing. */
export const load: PageServerLoad = async (event) => ({
	order: await adminLoad<OrderDetail>(event, `/admin/orders/${event.params.id}`),
	resent: event.url.searchParams.get('reenvio') === 'listo'
});

export const actions: Actions = {
	/**
	 * "Reenviar la compra" (S5), two steps without JavaScript: the first post checks the optional
	 * corrected email and asks for confirmation with a fresh request id; "Sí, enviar" posts again with
	 * confirm=yes. The API decides who may, which orders, the limit and the email itself; the id makes
	 * a repeated post send once, and success redirects (303) so a reload does not post again.
	 */
	resend: async (event) => {
		const form = await event.request.formData();
		const typed = String(form.get('email') ?? '').trim();
		const email = typed ? orderEmailSchema.safeParse(typed) : null;
		if (email && !email.success) return fail(400, { action: 'resend', ok: false, email: typed, message: 'Ingresá un email válido' });
		const corrected = email?.data ?? '';
		if (form.get('confirm') !== 'yes') return { action: 'resend', confirm: true, email: corrected, requestId: randomUUID() };

		const requestId = String(form.get('requestId') ?? '');
		const result = await adminApi<{ to: string; emailCorrected: boolean; resendsLeft: number }>(event, `/admin/orders/${event.params.id}/resend`, {
			method: 'POST',
			body: { requestId, ...(corrected ? { email: corrected } : {}) }
		});
		if (!result.ok) return fail(result.status, { action: 'resend', ok: false, email: corrected, message: result.message });
		redirect(303, `/admin/pedidos/${event.params.id}?reenvio=listo`);
	}
};
