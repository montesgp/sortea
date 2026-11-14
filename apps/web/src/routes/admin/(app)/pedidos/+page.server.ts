import { adminListLoad } from '#lib/server/admin.js';
import type { PageServerLoad } from './$types';

interface OrdersPage {
	orders: { id: string; reference: string; status: string; totalMinor: number; currency: string; deliveryMethod: string; buyer: string; email: string; province: string | null; createdAt: string; paidAt: string | null }[];
	page: number;
	pageSize: number;
	total: number;
}

export const load: PageServerLoad = async (event) => adminListLoad<OrdersPage>(event, '/admin/orders', ['status', 'q', 'from', 'to', 'page'], { from: 'Desde', to: 'Hasta' });
