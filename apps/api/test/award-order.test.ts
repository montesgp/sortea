import { and, count, eq, schema as s } from '@sortea/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminHeaders, createTenant, createTestContext, openCampaign, placeOrder, webhookRequest, type TenantFixture, type TestContext } from './helpers';

/**
 * odd/tasks/draw-room.md T2 (S4), ADR 0014 §4: each campaign says which prize
 * the first Quiniela match goes to, from the first prize to the last (today's
 * rule, the default) or from the last to the first. It is an essential rule:
 * set when the campaign is created or edited while its prizes are editable,
 * frozen once it opens, and the Quiniela record follows it.
 */
let ctx: TestContext;

async function call(target: TenantFixture, method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown, userId = target.ownerId) {
	return ctx.app.inject({ method, url, headers: await adminHeaders(ctx, target, userId), payload: payload as Record<string, unknown> | undefined });
}

async function setPrize(target: TenantFixture, kind: string, patch: Record<string, unknown>) {
	const { prizes } = (await call(target, 'GET', `/admin/campaigns/${target.campaignId}/prizes`)).json() as { prizes: { id: string; kind: string }[] };
	const response = await call(target, 'PATCH', `/admin/prizes/${prizes.find((prize) => prize.kind === kind)!.id}`, patch);
	expect(response.statusCode, response.body).toBe(200);
}

const storedOrder = async (target: TenantFixture, campaignId = target.campaignId) =>
	(await ctx.db.withTenant(target.id, (tx) => tx.select({ awardOrder: s.campaigns.awardOrder }).from(s.campaigns).where(eq(s.campaigns.id, campaignId))))[0]!.awardOrder;
const audits = async (target: TenantFixture, action: string) =>
	(await ctx.db.withTenant(target.id, (tx) => tx.select({ value: count() }).from(s.auditEvents).where(eq(s.auditEvents.action, action))))[0]!.value;

/**
 * A three-prize shape: the moto (1 unit) first, five cash units, a service (the
 * kit) last, every one from the Quiniela and none with alternates. Four orders
 * hold coupons 0000-0007; the campaign is awarding with its manifest published.
 */
async function threePrizeCampaign(label: string, awardOrder?: 'first_to_last' | 'last_to_first') {
	const target = await createTenant(ctx, label);
	ctx.clock.now = new Date('2026-10-25T15:00:00Z');
	await setPrize(target, 'vehicle', { alternatesCount: 0, mechanism: 'quiniela' });
	await setPrize(target, 'cash', { quantity: 5, alternatesCount: 0, mechanism: 'quiniela' });
	await setPrize(target, 'product', { title: 'Service completo', quantity: 1, alternatesCount: 0, mechanism: 'quiniela' });
	if (awardOrder) expect((await call(target, 'PATCH', `/admin/campaigns/${target.campaignId}`, { awardOrder })).statusCode).toBe(200);
	await openCampaign(ctx, target);
	for (let index = 0; index < 4; index++) {
		ctx.clock.now = new Date(ctx.clock.now.getTime() + 60_000);
		const order = await placeOrder(ctx, target, {
			buyer: { documentType: 'DNI', documentNumber: String(32_000_000 + index), firstName: `Persona${index}`, lastName: 'Prueba', email: `p${index}@example.com`, phone: '+54 9 11 2345-6789', province: 'Salta', city: 'Salta' }
		});
		const payment = ctx.simulator.pay(order.checkoutId, 'approved');
		expect((await ctx.app.inject(webhookRequest(target, payment.id))).statusCode).toBe(200);
	}
	ctx.clock.now = new Date('2026-11-29T01:00:00Z');
	expect((await call(target, 'POST', `/admin/campaigns/${target.campaignId}/close`)).statusCode).toBe(200);
	expect((await call(target, 'POST', `/admin/campaigns/${target.campaignId}/transition`, { to: 'awarding' })).statusCode).toBe(200);
	ctx.clock.now = new Date('2026-11-30T12:00:00Z');
	return target;
}

/** Records a Quiniela whose first seven extracts are coupons 0000-0006, in that order. */
async function recordQuiniela(target: TenantFixture) {
	const body = { source: 'Quiniela de la Ciudad, Nocturna', drawnAt: '2026-11-30T00:00:00Z', extracts: [0, 1, 2, 3, 4, 5, 6, ...Array.from({ length: 13 }, (_, index) => 1_000 + index)], evidenceUrl: 'https://loteria.example/extracto.pdf' };
	const previewed = await call(target, 'POST', `/admin/campaigns/${target.campaignId}/quiniela/preview`, body, target.operatorId);
	expect(previewed.statusCode, previewed.body).toBe(200);
	const confirmed = await call(target, 'POST', `/admin/campaigns/${target.campaignId}/quiniela`, { ...body, digest: previewed.json().digest }, target.operatorId);
	expect(confirmed.statusCode, confirmed.body).toBe(200);
	return { preview: previewed.json() as { slots: { prizeTitle: string; slot: number; winner: { entryNumber: number } | null }[] }, board: confirmed.json() };
}

async function storedWinners(target: TenantFixture) {
	const rows = await ctx.db.withTenant(target.id, (tx) =>
		tx
			.select({ title: s.prizes.title, slot: s.prizeAwards.slot, entryNumber: s.participationEntries.entryNumber, notes: s.prizeAwards.notes })
			.from(s.prizeAwards)
			.innerJoin(s.prizes, eq(s.prizes.id, s.prizeAwards.prizeId))
			.innerJoin(s.participationEntries, eq(s.participationEntries.id, s.prizeAwards.entryId))
			.where(and(eq(s.prizeAwards.campaignId, target.campaignId), eq(s.prizeAwards.role, 'winner')))
	);
	return rows.map((row) => `${row.entryNumber} ${row.title}#${row.slot} (${row.notes})`).sort();
}

beforeAll(async () => {
	ctx = await createTestContext();
});
afterAll(() => ctx.close());

describe('setting the award order', () => {
	let tenant: TenantFixture;
	const rules = '# Bases y condiciones\n\nTexto inicial de las bases de la campaña.';
	const create = (payload: Record<string, unknown>) =>
		call(tenant, 'POST', '/admin/campaigns', { title: 'Honda Wave 0 km', summary: 'Sorteamos una Honda Wave 0 km entre quienes compran.', rulesMarkdown: rules, ...payload });

	beforeAll(async () => {
		tenant = await createTenant(ctx, 'award-order');
	});

	it('creates a campaign from the first prize to the last unless told otherwise', async () => {
		const plain = await create({ slug: 'wave-default' });
		expect(plain.statusCode, plain.body).toBe(201);
		expect(plain.json().awardOrder).toBe('first_to_last');
		const reversed = await create({ slug: 'wave-reversed', awardOrder: 'last_to_first' });
		expect(reversed.statusCode, reversed.body).toBe(201);
		expect(reversed.json().awardOrder).toBe('last_to_first');
		expect(await storedOrder(tenant, reversed.json().id)).toBe('last_to_first');
		expect((await call(tenant, 'GET', `/admin/campaigns/${reversed.json().id}`)).json().awardOrder).toBe('last_to_first');
	});

	it('refuses an order it does not know, next to the field, and creates nothing', async () => {
		const before = (await ctx.db.withTenant(tenant.id, (tx) => tx.select({ value: count() }).from(s.campaigns)))[0]!.value;
		const response = await create({ slug: 'wave-bad', awardOrder: 'random' });
		expect(response.statusCode).toBe(400);
		expect(response.json().error.details.fieldErrors).toEqual({ awardOrder: ['Elegí el orden de adjudicación'] });
		expect((await ctx.db.withTenant(tenant.id, (tx) => tx.select({ value: count() }).from(s.campaigns)))[0]!.value).toBe(before);
	});

	it('changes while the prizes are editable, audited with the other campaign fields', async () => {
		const before = await audits(tenant, 'campaign.updated');
		const response = await call(tenant, 'PATCH', `/admin/campaigns/${tenant.campaignId}`, { awardOrder: 'last_to_first' });
		expect(response.statusCode, response.body).toBe(200);
		expect(response.json().awardOrder).toBe('last_to_first');
		expect(await storedOrder(tenant)).toBe('last_to_first');
		expect(await audits(tenant, 'campaign.updated')).toBe(before + 1);
		const invalid = await call(tenant, 'PATCH', `/admin/campaigns/${tenant.campaignId}`, { awardOrder: 'random' });
		expect(invalid.statusCode).toBe(400);
		expect(await storedOrder(tenant)).toBe('last_to_first');
	});

	it('is frozen once the campaign opens: a change is refused and nothing is written, the same value passes', async () => {
		await openCampaign(ctx, tenant);
		const before = await audits(tenant, 'campaign.updated');
		const refused = await call(tenant, 'PATCH', `/admin/campaigns/${tenant.campaignId}`, { awardOrder: 'first_to_last', title: 'Otro título' });
		expect(refused.statusCode).toBe(409);
		expect(refused.json().error).toMatchObject({
			code: 'award_order_locked',
			message: 'El orden de adjudicación queda fijo cuando la campaña abre: forma parte de lo publicado en las bases'
		});
		expect(await storedOrder(tenant)).toBe('last_to_first');
		expect((await call(tenant, 'GET', `/admin/campaigns/${tenant.campaignId}`)).json().title).toBe('Moto 0 km');
		expect(await audits(tenant, 'campaign.updated')).toBe(before);

		const same = await call(tenant, 'PATCH', `/admin/campaigns/${tenant.campaignId}`, { awardOrder: 'last_to_first', title: 'Moto 0 km nueva' });
		expect(same.statusCode, same.body).toBe(200);
		expect(same.json()).toMatchObject({ awardOrder: 'last_to_first', title: 'Moto 0 km nueva' });
	});

	it('is the operator’s to read, not to set', async () => {
		const response = await call(tenant, 'PATCH', `/admin/campaigns/${tenant.campaignId}`, { awardOrder: 'first_to_last' }, tenant.operatorId);
		expect(response.statusCode).toBe(403);
		expect(await storedOrder(tenant)).toBe('last_to_first');
	});
});

describe('the Quiniela record follows the award order', () => {
	it('from the last prize: the first match takes the service, the next five the cash units 1 to 5, the next the moto', async () => {
		const target = await threePrizeCampaign('award-order-reverse', 'last_to_first');
		const { preview, board } = await recordQuiniela(target);
		expect(preview.slots.map((slot) => [slot.prizeTitle, slot.slot, slot.winner?.entryNumber])).toEqual([
			['Service completo', 1, 0],
			['$100.000', 1, 1],
			['$100.000', 2, 2],
			['$100.000', 3, 3],
			['$100.000', 4, 4],
			['$100.000', 5, 5],
			['Moto', 1, 6]
		]);
		expect(await storedWinners(target)).toEqual([
			'0 Service completo#1 (Extracto 1.º de la Quiniela)',
			'1 $100.000#1 (Extracto 2.º de la Quiniela)',
			'2 $100.000#2 (Extracto 3.º de la Quiniela)',
			'3 $100.000#3 (Extracto 4.º de la Quiniela)',
			'4 $100.000#4 (Extracto 5.º de la Quiniela)',
			'5 $100.000#5 (Extracto 6.º de la Quiniela)',
			'6 Moto#1 (Extracto 7.º de la Quiniela)'
		]);
		// No alternates anywhere: every prize has 0.
		expect((await ctx.db.withTenant(target.id, (tx) => tx.select({ value: count() }).from(s.prizeAwards).where(eq(s.prizeAwards.role, 'alternate'))))[0]!.value).toBe(0);
		expect(board.campaign.awardOrder).toBe('last_to_first');
		expect(board.prizes.map((prize: { title: string; alternatesCount: number; slots: { state: string }[] }) => [prize.title, prize.alternatesCount, prize.slots.map((slot) => slot.state)])).toEqual([
			['Moto', 0, ['verifying']],
			['$100.000', 0, ['verifying', 'verifying', 'verifying', 'verifying', 'verifying']],
			['Service completo', 0, ['verifying']]
		]);
	});

	it('from the first prize, as before: the moto, then the cash units, then the service', async () => {
		const target = await threePrizeCampaign('award-order-forward');
		await recordQuiniela(target);
		expect(await storedWinners(target)).toEqual([
			'0 Moto#1 (Extracto 1.º de la Quiniela)',
			'1 $100.000#1 (Extracto 2.º de la Quiniela)',
			'2 $100.000#2 (Extracto 3.º de la Quiniela)',
			'3 $100.000#3 (Extracto 4.º de la Quiniela)',
			'4 $100.000#4 (Extracto 5.º de la Quiniela)',
			'5 $100.000#5 (Extracto 6.º de la Quiniela)',
			'6 Service completo#1 (Extracto 7.º de la Quiniela)'
		]);
		expect((await call(target, 'GET', `/admin/campaigns/${target.campaignId}/awards`)).json().campaign.awardOrder).toBe('first_to_last');
	});
});
