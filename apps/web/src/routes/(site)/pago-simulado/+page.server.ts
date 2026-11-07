import { paymentsSimulator } from '#lib/server/config.js';
import { error, fail, redirect } from '@sveltejs/kit';
import { api } from '#lib/server/api.js';
import type { Actions, PageServerLoad } from './$types';

interface SimulatedOrder {
	id: string;
	reference: string;
	items: { title: string; quantity: number; unitPriceMinor: number; currency: string }[];
	totalMinor: number;
	returnUrl: string;
}

/** Local payment simulator (development only): it stands in for a Mercado Pago order and drives the same signed-webhook path. */
export const load: PageServerLoad = async (event) => {
	if (!paymentsSimulator()) error(404, 'No encontrado');
	const id = event.url.searchParams.get('order_id') ?? '';
	const result = await api<SimulatedOrder>(event, `/dev/simulator/orders/${encodeURIComponent(id)}`);
	if (!result.ok) error(404, 'Pago simulado no encontrado');
	return { order: result.data };
};

export const actions: Actions = {
	default: async (event) => {
		if (!paymentsSimulator()) error(404, 'No encontrado');
		const form = await event.request.formData();
		const result = await api<{ returnUrl: string }>(event, '/dev/simulator/pay', {
			method: 'POST',
			body: { orderId: String(form.get('orderId')), outcome: String(form.get('outcome')) }
		});
		if (!result.ok) return fail(400, { message: result.message });
		redirect(303, result.data.returnUrl);
	}
};
