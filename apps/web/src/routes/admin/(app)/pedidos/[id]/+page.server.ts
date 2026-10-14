import { adminLoad } from '#lib/server/admin.js';
import type { PageServerLoad } from './$types';

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
	buyer: { firstName: string; lastName: string; email: string; phone: string | null; document: string | null; address: Record<string, string> | null };
	items: { name: string; kind: string; quantity: number; unitPriceMinor: number; lineTotalMinor: number }[];
	payments: { providerPaymentId: string; status: string; statusDetail: string | null; amountMinor: number; approvedAt: string | null; updatedAt: string }[];
	entries: { number: number; status: string }[];
	consents: { purpose: string; granted: boolean; policyVersion: string; recordedAt: string }[];
}

export const load: PageServerLoad = async (event) => ({ order: await adminLoad<OrderDetail>(event, `/admin/orders/${event.params.id}`) });
