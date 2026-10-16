import { adminLoad } from '#lib/server/admin.js';
import type { PageServerLoad } from './$types';

interface OrdersPage {
	orders: { id: string; reference: string; status: string; totalMinor: number; currency: string; deliveryMethod: string; buyer: string; email: string; province: string | null; createdAt: string; paidAt: string | null }[];
	page: number;
	pageSize: number;
	total: number;
}

export const load: PageServerLoad = async (event) => {
	const params = new URLSearchParams();
	for (const key of ['status', 'q', 'page']) {
		const value = event.url.searchParams.get(key);
		if (value) params.set(key, value);
	}
	return {
		result: await adminLoad<OrdersPage>(event, `/admin/orders?${params}`),
		filters: { status: event.url.searchParams.get('status') ?? '', q: event.url.searchParams.get('q') ?? '' }
	};
};
