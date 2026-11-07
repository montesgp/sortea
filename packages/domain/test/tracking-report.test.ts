import { describe, expect, it } from 'vitest';
import { campaignPerformance, summarizePurchases, trackingPerformance, type PerformanceOrder } from '../src';

/** odd/tasks/tracking-links.md S4: per link "participó" and "último", "Sin link" by network, network and campaign totals. */
const order = (overrides: Partial<PerformanceOrder> = {}): PerformanceOrder => ({
	contactId: 'ana',
	chances: 2,
	grossMinor: 1_000,
	netMinor: 900,
	sourceChannel: null,
	links: [],
	...overrides
});

const links = [
	{ id: 'a', channel: 'instagram' as const, name: 'Video A' },
	{ id: 'b', channel: 'tiktok' as const, name: 'Video B' },
	{ id: 'c', channel: 'instagram' as const, name: 'Sin compras' }
];

const empty = { purchases: 0, buyers: 0, chances: 0, grossMinor: 0, netMinor: 0, netUnknown: 0 };

describe('summarizePurchases', () => {
	it('counts purchases, distinct buyers, chances, gross and the net that is known', () => {
		expect(
			summarizePurchases([
				order({ contactId: 'ana', chances: 3, grossMinor: 1_000, netMinor: 900 }),
				order({ contactId: 'ana', chances: 1, grossMinor: 500, netMinor: null }),
				order({ contactId: 'beto', chances: 10, grossMinor: 4_000, netMinor: 3_700 })
			])
		).toEqual({ purchases: 3, buyers: 2, chances: 14, grossMinor: 5_500, netMinor: 4_600, netUnknown: 1 });
	});

	it('is all zeros without purchases', () => {
		expect(summarizePurchases([])).toEqual(empty);
	});
});

describe('trackingPerformance', () => {
	const orders = [
		// A then B: both participate, B is the last.
		order({ contactId: 'ana', chances: 2, grossMinor: 1_000, netMinor: 900, links: [{ linkId: 'a', isLast: false }, { linkId: 'b', isLast: true }] }),
		// Only A, twice by the same buyer.
		order({ contactId: 'beto', chances: 5, grossMinor: 2_500, netMinor: 2_300, links: [{ linkId: 'a', isLast: true }] }),
		order({ contactId: 'beto', chances: 1, grossMinor: 500, netMinor: null, links: [{ linkId: 'a', isLast: true }] }),
		// Without a link: one guessed from Instagram, one unknown.
		order({ contactId: 'caro', chances: 4, grossMinor: 2_000, netMinor: 1_800, sourceChannel: 'instagram' }),
		order({ contactId: 'dani', chances: 1, grossMinor: 300, netMinor: 280 })
	];
	const report = trackingPerformance(links, orders);

	it('credits every link a purchase passed through in "participó" and only its last link in "último"', () => {
		const [a, b, c] = report.links;
		expect(a).toMatchObject({ id: 'a', name: 'Video A' });
		expect(a!.participated).toEqual({ purchases: 3, buyers: 2, chances: 8, grossMinor: 4_000, netMinor: 3_200, netUnknown: 1 });
		expect(a!.last).toEqual({ purchases: 2, buyers: 1, chances: 6, grossMinor: 3_000, netMinor: 2_300, netUnknown: 1 });
		expect(b!.participated).toEqual({ purchases: 1, buyers: 1, chances: 2, grossMinor: 1_000, netMinor: 900, netUnknown: 0 });
		expect(b!.last).toEqual(b!.participated);
		// A link without purchases still has its row, with zeros.
		expect(c).toMatchObject({ id: 'c', participated: empty, last: empty });
	});

	it('lists purchases without a link by the guessed network, unknown last', () => {
		expect(report.withoutLink).toEqual([
			{ channel: 'instagram', purchases: 1, buyers: 1, chances: 4, grossMinor: 2_000, netMinor: 1_800, netUnknown: 0 },
			{ channel: null, purchases: 1, buyers: 1, chances: 1, grossMinor: 300, netMinor: 280, netUnknown: 0 }
		]);
	});

	it('totals each network with its links\' "último" plus its purchases without a link', () => {
		expect(report.channels).toEqual([
			{ channel: 'instagram', purchases: 3, buyers: 2, chances: 10, grossMinor: 5_000, netMinor: 4_100, netUnknown: 1 },
			{ channel: 'tiktok', purchases: 1, buyers: 1, chances: 2, grossMinor: 1_000, netMinor: 900, netUnknown: 0 },
			{ channel: null, purchases: 1, buyers: 1, chances: 1, grossMinor: 300, netMinor: 280, netUnknown: 0 }
		]);
	});

	it('gives a campaign total equal to the sum of "último" and "Sin link"', () => {
		expect(report.total).toEqual({ purchases: 5, buyers: 4, chances: 13, grossMinor: 6_300, netMinor: 5_280, netUnknown: 1 });
		const additive = ['purchases', 'chances', 'grossMinor', 'netMinor', 'netUnknown'] as const;
		for (const key of additive) {
			const lastSum = report.links.reduce((sum, link) => sum + link.last[key], 0);
			const withoutSum = report.withoutLink.reduce((sum, row) => sum + row[key], 0);
			const channelSum = report.channels.reduce((sum, row) => sum + row[key], 0);
			expect(lastSum + withoutSum, key).toBe(report.total[key]);
			expect(channelSum, key).toBe(report.total[key]);
		}
	});

	it('takes the most recent link as the last when none is marked', () => {
		const unmarked = trackingPerformance(links, [order({ links: [{ linkId: 'a', isLast: false }, { linkId: 'b', isLast: false }] })]);
		expect(unmarked.links.map((link) => [link.id, link.last.purchases])).toEqual([
			['a', 0],
			['b', 1],
			['c', 0]
		]);
		expect(unmarked.total.purchases).toBe(1);
	});

	it('is empty but complete for a campaign without purchases', () => {
		const none = trackingPerformance(links, []);
		expect(none.links.map((link) => link.last)).toEqual([empty, empty, empty]);
		expect(none.withoutLink).toEqual([]);
		expect(none.channels).toEqual([]);
		expect(none.total).toEqual(empty);
	});
});

describe('campaignPerformance', () => {
	it('summarizes a campaign and splits its purchases with and without a link', () => {
		expect(
			campaignPerformance([
				order({ contactId: 'ana', links: [{ linkId: 'a', isLast: true }] }),
				order({ contactId: 'ana', sourceChannel: 'instagram' }),
				order({ contactId: 'beto', netMinor: null })
			])
		).toEqual({ purchases: 3, buyers: 2, chances: 6, grossMinor: 3_000, netMinor: 1_800, netUnknown: 1, withLink: 1, withoutLink: 2 });
	});
});
