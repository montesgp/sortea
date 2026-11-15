import { randomUUID } from 'node:crypto';
import { and, asc, count, eq, schema as s } from '@sortea/db';
import { parseManifest, serializeManifest } from '@sortea/domain';
import { hashManifest, holderPseudonym } from '@sortea/domain/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { rehearsalResetAllowed } from '../src/modules/rehearsal';
import { adminHeaders, createTenant, createTestContext, openCampaign, placeOrder, webhookRequest, type TenantFixture, type TestContext } from './helpers';

/**
 * Owner feedback 2026-11-14, S5 (L2) and ADR 0026 §7: "Reiniciar ensayo". Outside production, a
 * demo campaign's draw can be rehearsed again: the API copies the campaign (fields, prizes, the
 * locked rules, the coupons) into a new one without any draw, with its own manifest published,
 * and answers its id. The source and its draws are never touched (draws are append-only).
 */
let ctx: TestContext;
let tenant: TenantFixture;
let other: TenantFixture;
const hostId = randomUUID();
const auditorId = randomUUID();

const buyers = [
	{ documentNumber: '30.111.222', firstName: 'Juana', lastName: 'Pérez', email: 'juana.perez@example.com' },
	{ documentNumber: '30.333.444', firstName: 'Martín', lastName: 'Gómez', email: 'martin.gomez@example.com' },
	{ documentNumber: '30.555.666', firstName: 'Lucía', lastName: 'Ñáñez', email: 'lucia.nanez@example.com' }
];

async function as(userId: string, method: 'GET' | 'POST', url: string, target = tenant, app = ctx.app) {
	return app.inject({ method, url, headers: await adminHeaders(ctx, target, userId) });
}
const resetUrl = (campaignId: string) => `/admin/campaigns/${campaignId}/rehearsal/reset`;
const roomUrl = (campaignId: string) => `/admin/draw-room/campaigns/${campaignId}`;

async function setPrize(target: TenantFixture, kind: string, patch: Record<string, unknown>) {
	const auth = await adminHeaders(ctx, target);
	const { prizes } = (await ctx.app.inject({ method: 'GET', url: `/admin/campaigns/${target.campaignId}/prizes`, headers: auth })).json() as { prizes: { id: string; kind: string }[] };
	const response = await ctx.app.inject({ method: 'PATCH', url: `/admin/prizes/${prizes.find((prize) => prize.kind === kind)!.id}`, headers: auth, payload: patch });
	expect(response.statusCode, response.body).toBe(200);
}

/** Three buyers with two coupons each (0000-0005), every prize drawn in the app; closed, awarding and marked demo. */
async function rehearsalTenant(label: string, demo = true) {
	const target = await createTenant(ctx, label);
	ctx.clock.now = new Date('2026-10-25T15:00:00Z');
	await setPrize(target, 'vehicle', { alternatesCount: 0, mechanism: 'app', imageUrl: 'https://cdn.example/moto.jpg' });
	await setPrize(target, 'cash', { quantity: 2, alternatesCount: 0, mechanism: 'app' });
	await setPrize(target, 'product', { quantity: 1, alternatesCount: 0, mechanism: 'app' });
	await openCampaign(ctx, target);
	for (const buyer of buyers) {
		ctx.clock.now = new Date(ctx.clock.now.getTime() + 60_000);
		const order = await placeOrder(ctx, target, {
			buyer: { documentType: 'DNI', documentNumber: buyer.documentNumber, firstName: buyer.firstName, lastName: buyer.lastName, email: buyer.email, phone: '+54 9 11 5555-0001', province: 'Salta', city: 'Cafayate' }
		});
		const payment = ctx.simulator.pay(order.checkoutId, 'approved');
		expect((await ctx.app.inject(webhookRequest(target, payment.id))).statusCode).toBe(200);
	}
	ctx.clock.now = new Date('2026-11-29T01:00:00Z');
	expect((await as(target.ownerId, 'POST', `/admin/campaigns/${target.campaignId}/close`, target)).statusCode).toBe(200);
	const transition = await ctx.app.inject({ method: 'POST', url: `/admin/campaigns/${target.campaignId}/transition`, headers: await adminHeaders(ctx, target), payload: { to: 'awarding' } });
	expect(transition.statusCode, transition.body).toBe(200);
	if (demo) await ctx.db.withTenant(target.id, (tx) => tx.update(s.campaigns).set({ isDemo: true }).where(eq(s.campaigns.id, target.campaignId)));
	ctx.clock.now = new Date('2026-11-30T12:00:00.500Z');
	return target;
}

/** Everything of a campaign a reset must leave as it was. */
async function campaignState(target: TenantFixture, campaignId: string) {
	return ctx.db.withTenant(target.id, async (tx) => {
		const [campaign] = await tx.select().from(s.campaigns).where(eq(s.campaigns.id, campaignId));
		const [entries, prizes, manifests, events, draws, reveals, awards, unitDraws] = await Promise.all([
			tx.select().from(s.participationEntries).where(eq(s.participationEntries.campaignId, campaignId)).orderBy(asc(s.participationEntries.entryNumber)),
			tx.select().from(s.prizes).where(eq(s.prizes.campaignId, campaignId)).orderBy(asc(s.prizes.position)),
			tx.select().from(s.drawManifests).where(eq(s.drawManifests.campaignId, campaignId)),
			tx.select().from(s.drawEvents).where(eq(s.drawEvents.campaignId, campaignId)).orderBy(asc(s.drawEvents.createdAt)),
			tx.select().from(s.appPrizeDraws).where(eq(s.appPrizeDraws.campaignId, campaignId)),
			tx.select({ value: count() }).from(s.appPrizeDrawReveals),
			tx.select().from(s.prizeAwards).where(eq(s.prizeAwards.campaignId, campaignId)),
			tx.select().from(s.appUnitDraws).where(eq(s.appUnitDraws.campaignId, campaignId))
		]);
		return { campaign, entries, prizes, manifests, events, draws, reveals: reveals[0]!.value, awards, unitDraws };
	});
}

async function counts(target: TenantFixture) {
	return ctx.db.withTenant(target.id, async (tx) => {
		const [[campaigns], [audits], [entries]] = await Promise.all([
			tx.select({ value: count() }).from(s.campaigns),
			tx.select({ value: count() }).from(s.auditEvents),
			tx.select({ value: count() }).from(s.participationEntries)
		]);
		return { campaigns: campaigns!.value, audits: audits!.value, entries: entries!.value };
	});
}

beforeAll(async () => {
	ctx = await createTestContext();
	other = await rehearsalTenant('rehearsal-other');
	tenant = await rehearsalTenant('rehearsal');
	await ctx.db.withPlatform((db) =>
		db.insert(s.organizationMembers).values([
			{ organizationId: tenant.id, userId: hostId, email: `host@${tenant.host}`, role: 'draw_host' },
			{ organizationId: tenant.id, userId: auditorId, email: `auditor@${tenant.host}`, role: 'auditor' }
		])
	);
	// The source has a tirada already: the moto is drawn, the rest pending.
	const room = (await as(hostId, 'GET', roomUrl(tenant.campaignId))).json() as { prizes: { id: string; title: string }[] };
	const drawn = await as(hostId, 'POST', `/admin/campaigns/${tenant.campaignId}/app-draw/prizes/${room.prizes.find((prize) => prize.title === 'Moto')!.id}`);
	expect(drawn.statusCode, drawn.body).toBe(201);
});
afterAll(() => ctx.close());

describe('where a rehearsal can be reset', () => {
	it('only in staging, or in local development and tests; never in production, nor in a production build without the variable', () => {
		expect(rehearsalResetAllowed({ NODE_ENV: 'production', DEPLOY_ENVIRONMENT: 'staging' })).toBe(true);
		expect(rehearsalResetAllowed({ NODE_ENV: 'development', DEPLOY_ENVIRONMENT: undefined })).toBe(true);
		expect(rehearsalResetAllowed({ NODE_ENV: 'test', DEPLOY_ENVIRONMENT: undefined })).toBe(true);
		expect(rehearsalResetAllowed({ NODE_ENV: 'development', DEPLOY_ENVIRONMENT: 'development' })).toBe(true);
		expect(rehearsalResetAllowed({ NODE_ENV: 'production', DEPLOY_ENVIRONMENT: 'production' })).toBe(false);
		expect(rehearsalResetAllowed({ NODE_ENV: 'development', DEPLOY_ENVIRONMENT: 'production' })).toBe(false);
		expect(rehearsalResetAllowed({ NODE_ENV: 'production', DEPLOY_ENVIRONMENT: undefined })).toBe(false);
		expect(rehearsalResetAllowed({ NODE_ENV: 'production', DEPLOY_ENVIRONMENT: 'development' })).toBe(false);
		expect(rehearsalResetAllowed({ NODE_ENV: 'production', DEPLOY_ENVIRONMENT: 'Staging-2' })).toBe(false);
	});

	it('the draw room says whether this campaign can be reset', async () => {
		expect((await as(hostId, 'GET', roomUrl(tenant.campaignId))).json().rehearsal).toEqual({ resettable: true });
	});
});

describe('Reiniciar ensayo', () => {
	it('copies the demo campaign without its draws, with the same coupons and its own published manifest, and leaves the source as it was', async () => {
		const before = await campaignState(tenant, tenant.campaignId);
		expect(before.draws).toHaveLength(1);
		expect(before.awards).toHaveLength(1);
		const beforeCounts = await counts(tenant);

		const response = await as(hostId, 'POST', resetUrl(tenant.campaignId));
		expect(response.statusCode, response.body).toBe(201);
		const body = response.json() as { id: string; slug: string; title: string };
		expect(body).toEqual({ id: expect.any(String), slug: 'moto-ensayo-1', title: 'Moto 0 km (ensayo 1)' });

		// The source: not one row changed.
		expect(await campaignState(tenant, tenant.campaignId)).toEqual(before);

		const copy = await campaignState(tenant, body.id);
		const source = before.campaign!;
		expect(copy.campaign).toMatchObject({
			slug: 'moto-ensayo-1',
			title: 'Moto 0 km (ensayo 1)',
			summary: source.summary,
			status: 'awarding',
			isDemo: true,
			timezone: source.timezone,
			entryDigits: source.entryDigits,
			awardOrder: source.awardOrder,
			nextEntryNumber: source.nextEntryNumber,
			currentRound: 1,
			requiredApprovals: source.requiredApprovals
		});
		// Its dates keep their spacing and the close is in the past.
		expect(copy.campaign!.closesAt!.getTime()).toBeLessThan(ctx.clock.now.getTime());
		expect(copy.campaign!.closesAt!.getTime() - copy.campaign!.opensAt!.getTime()).toBe(source.closesAt!.getTime() - source.opensAt!.getTime());

		// Same prizes, mechanism, quantities, alternates and images; no draw, award or tirada.
		const prizeFields = ({ position, kind, title, description, declaredValueMinor, currency, quantity, alternatesCount, mechanism, conditions, imageUrl, video }: (typeof copy.prizes)[number]) =>
			({ position, kind, title, description, declaredValueMinor, currency, quantity, alternatesCount, mechanism, conditions, imageUrl, video });
		expect(copy.prizes.map(prizeFields)).toEqual(before.prizes.map(prizeFields));
		expect(copy.prizes.every((prize) => !before.prizes.some((original) => original.id === prize.id))).toBe(true);
		expect(copy.draws).toEqual([]);
		expect(copy.awards).toEqual([]);
		expect(copy.unitDraws).toEqual([]);

		// The same coupons, for the same buyers and orders, with the copy's own pseudonyms.
		expect(copy.entries.map(({ entryNumber, contactId, orderId, status }) => ({ entryNumber, contactId, orderId, status }))).toEqual(
			before.entries.map(({ entryNumber, contactId, orderId, status }) => ({ entryNumber, contactId, orderId, status }))
		);
		for (const entry of copy.entries) expect(entry.holderPseudonym).toBe(holderPseudonym(ctx.deps.config.PSEUDONYM_PEPPER, body.id, entry.contactId));

		// A manifest of the copy, published, whose SHA-256 is that of its own content.
		expect(copy.manifests).toHaveLength(1);
		const [manifest] = copy.manifests;
		const parsed = parseManifest(manifest!.content);
		expect(serializeManifest(parsed)).toBe(manifest!.content);
		expect(hashManifest(parsed)).toBe(manifest!.sha256);
		expect(parsed.header).toMatchObject({ format: 'sortea.manifest.v2', campaignId: body.id, round: 1, entryDigits: 4, eligibleCount: 6, voidCount: 0 });
		expect(parsed.entries.map((entry) => entry.entryNumber)).toEqual([0, 1, 2, 3, 4, 5]);
		expect(manifest).toMatchObject({ round: 1, eligibleCount: 6, voidCount: 0, publishedAt: ctx.clock.now });
		expect(copy.events.map((event) => ({ kind: event.kind, title: event.title, detail: event.detail }))).toEqual([
			{ kind: 'manifest_published', title: 'Lista de participaciones congelada y publicada', detail: `SHA-256 ${manifest!.sha256} · 6 participaciones válidas` }
		]);

		// The locked rules, as they were.
		const rules = await ctx.db.withTenant(tenant.id, (tx) => tx.select().from(s.campaignRuleVersions).where(eq(s.campaignRuleVersions.campaignId, body.id)));
		const sourceRules = await ctx.db.withTenant(tenant.id, (tx) =>
			tx.select().from(s.campaignRuleVersions).where(and(eq(s.campaignRuleVersions.campaignId, tenant.campaignId), eq(s.campaignRuleVersions.status, 'locked')))
		);
		expect(rules.map(({ version, status, bodyMarkdown, entryRule, contentHash }) => ({ version, status, bodyMarkdown, entryRule, contentHash }))).toEqual(
			sourceRules.map(({ version, status, bodyMarkdown, entryRule, contentHash }) => ({ version, status, bodyMarkdown, entryRule, contentHash }))
		);
		expect(parsed.header.ruleVersion).toBe(sourceRules[0]!.version);
		// Approvals are never copied as granted: the copy's are pending.
		const approvals = await ctx.db.withTenant(tenant.id, (tx) => tx.select().from(s.campaignApprovals).where(eq(s.campaignApprovals.campaignId, body.id)));
		expect(approvals.map((approval) => approval.status).sort()).toEqual(['pending', 'pending']);

		// Audited once, naming both campaigns.
		const audited = await ctx.db.withTenant(tenant.id, (tx) => tx.select().from(s.auditEvents).where(eq(s.auditEvents.action, 'campaign.rehearsal_reset')));
		expect(audited).toHaveLength(1);
		expect(audited[0]).toMatchObject({ actorType: 'admin', actorId: hostId, targetType: 'campaign', targetId: body.id, metadata: { sourceCampaignId: tenant.campaignId, campaignId: body.id } });
		expect(await counts(tenant)).toEqual({ campaigns: beforeCounts.campaigns + 1, audits: beforeCounts.audits + 1, entries: beforeCounts.entries + 6 });

		// The copy's room: every prize pending, ready to draw again.
		const room = (await as(hostId, 'GET', roomUrl(body.id))).json();
		expect(room.campaign).toMatchObject({ id: body.id, title: 'Moto 0 km (ensayo 1)', status: 'awarding' });
		expect(room.coupons).toEqual({ eligible: 6 });
		expect(room.manifest.sha256).toBe(manifest!.sha256);
		expect(room.winners).toEqual([]);
		expect(room.appPrizes.prizes.map((prize: { state: string; reason: string | null }) => [prize.state, prize.reason])).toEqual([
			['pending', null],
			['pending', null],
			['pending', null]
		]);
		expect(room.rehearsal).toEqual({ resettable: true });
		// And it can be drawn.
		const draw = await as(hostId, 'POST', `/admin/campaigns/${body.id}/app-draw/prizes/${room.appPrizes.prizes[0].prizeId}`);
		expect(draw.statusCode, draw.body).toBe(201);
	});

	it('numbers the next copy after the last one, also when reset from a copy', async () => {
		const operator = await as(tenant.operatorId, 'POST', resetUrl(tenant.campaignId));
		expect(operator.statusCode, operator.body).toBe(201);
		expect(operator.json()).toMatchObject({ slug: 'moto-ensayo-2', title: 'Moto 0 km (ensayo 2)' });
		const fromCopy = await as(hostId, 'POST', resetUrl(operator.json().id));
		expect(fromCopy.statusCode, fromCopy.body).toBe(201);
		expect(fromCopy.json()).toMatchObject({ slug: 'moto-ensayo-3', title: 'Moto 0 km (ensayo 3)' });
	});

	it('is refused for a campaign that is not a demo, and changes nothing', async () => {
		const real = await rehearsalTenant('rehearsal-real', false);
		const before = await counts(real);
		expect((await as(real.ownerId, 'GET', roomUrl(real.campaignId), real)).json().rehearsal).toEqual({ resettable: false });
		const response = await as(real.ownerId, 'POST', resetUrl(real.campaignId), real);
		expect(response.statusCode).toBe(409);
		expect(response.json().error).toEqual({ code: 'not_a_rehearsal', message: 'Solo se reinicia el ensayo de una campaña de prueba' });
		expect(await counts(real)).toEqual(before);
	});

	it('is the organization own: another organization campaign is not found, and an auditor gets 403', async () => {
		const before = [await counts(tenant), await counts(other)];
		expect((await as(hostId, 'POST', resetUrl(other.campaignId))).statusCode).toBe(404);
		expect((await as(hostId, 'POST', resetUrl(randomUUID()))).statusCode).toBe(404);
		expect((await as(hostId, 'POST', '/admin/campaigns/not-a-uuid/rehearsal/reset')).statusCode).toBe(400);
		expect((await as(auditorId, 'POST', resetUrl(tenant.campaignId))).statusCode).toBe(403);
		expect([await counts(tenant), await counts(other)]).toEqual(before);
	});

	it('does not exist in production: 404, the room says it cannot be reset, and nothing changes', async () => {
		const production = await buildApp({ ...ctx.deps, config: { ...ctx.deps.config, NODE_ENV: 'production', DEPLOY_ENVIRONMENT: 'production' } });
		try {
			const before = await counts(tenant);
			const response = await as(hostId, 'POST', resetUrl(tenant.campaignId), tenant, production);
			expect(response.statusCode).toBe(404);
			expect(response.json().error.code).toBe('not_found');
			expect((await as(hostId, 'GET', roomUrl(tenant.campaignId), tenant, production)).json().rehearsal).toEqual({ resettable: false });
			expect(await counts(tenant)).toEqual(before);
		} finally {
			await production.close();
		}
	});
});
