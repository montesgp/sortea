import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createDatabase, eq, schema as s, type DatabaseHandle } from '@sortea/db';
import { downloadTokenHash, parseKeyRing, sealSecret } from '@sortea/domain/server';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { PermanentDeliveryError, type NotificationProvider, type OutgoingEmail } from '../src/notifications';
import { claimBatch, expireOrders, fetchTicketImage, MAX_ATTEMPTS, processEvent, pruneOpsEvents, type WorkerDeps } from '../src/processor';

let db: DatabaseHandle;
const keyRing = parseKeyRing(`v1:${randomBytes(32).toString('base64')}`);
const sent: OutgoingEmail[] = [];
let failing = false;
let rejection: Error | null = null;
const tried: OutgoingEmail[] = [];
const clock = { now: new Date('2026-10-25T15:00:00Z') };
const org = randomUUID();
const ids = { contact: randomUUID(), order: randomUUID(), product: randomUUID(), variant: randomUUID(), asset: randomUUID(), challenge: randomUUID() };

const email: NotificationProvider = {
	name: 'memory',
	async send(message) {
		tried.push(message);
		if (rejection) throw rejection;
		if (failing) throw new Error('smtp down');
		sent.push(message);
		return { messageId: `m-${sent.length}` };
	}
};

function deps(): WorkerDeps {
	return { db, keyRing, email, lookupPepper: 'pepper-for-worker-tests', webFallbackOrigin: 'http://localhost:5173', fromDomain: 'sortea.test', workerId: 'test', now: () => clock.now };
}

async function enqueue(topic: string, payload: Record<string, unknown>, availableAt = clock.now) {
	// Available on the test clock, not the database's now(): with the column default, events stayed in
	// the future of the fixed clock once real time passed it (2026-10-25 15:00 UTC) and none was picked.
	const [event] = await db.withPlatform((database) =>
		database.insert(s.outboxEvents).values({ organizationId: org, topic, dedupeKey: `${topic}:${randomUUID()}`, payload, availableAt }).returning()
	);
	return event!;
}

/** One worker pass, at the shared clock or at `now`. */
async function runOnce(now?: Date, extra: Partial<WorkerDeps> = {}) {
	const at: WorkerDeps = { ...deps(), ...(now ? { now: () => now } : {}), ...extra };
	const results = [];
	for (const event of await claimBatch(at)) results.push(await processEvent(at, event));
	return results;
}

beforeAll(async () => {
	db = createDatabase(inject('databaseUrl'), { max: 6 });
	await db.withPlatform(async (database) => {
		await database.insert(s.organizations).values({
			id: org,
			slug: `w-${org.slice(0, 6)}`,
			name: 'Taller Demo',
			orderPrefix: 'MG',
			settings: {
				contact: {},
				social: {},
				delivery: { pickupEnabled: true, shippingEnabled: false, shippingFeeMinor: 0 },
				legal: { termsVersion: 't', privacyVersion: 'p' }
			}
		});
		await database.insert(s.organizationDomains).values({ organizationId: org, hostname: 'tallerdemo.example', isPrimary: true });
		await database.insert(s.contacts).values({ id: ids.contact, organizationId: org, firstName: 'Juana', lastName: 'Pérez', email: 'juana@example.com' });
		await database.insert(s.products).values({ id: ids.product, organizationId: org, slug: 'manual', name: 'Manual', description: 'PDF', kind: 'digital', status: 'active' });
		await database.insert(s.productVariants).values({ id: ids.variant, organizationId: org, productId: ids.product, sku: 'M', name: 'Manual', priceMinor: 1_200_000 });
		await database.insert(s.productAssets).values({ id: ids.asset, organizationId: org, productId: ids.product, storagePath: 'x/manual.pdf', filename: 'manual.pdf', contentType: 'application/pdf', sizeBytes: 1 });
		await database.insert(s.orders).values({
			id: ids.order,
			organizationId: org,
			reference: 'MG-TEST0001',
			accessCodeHash: 'x',
			contactId: ids.contact,
			buyer: { firstName: 'Juana', lastName: 'Pérez', email: 'juana@example.com', phone: null },
			status: 'paid',
			currency: 'ARS',
			subtotalMinor: 1_200_000,
			deliveryFeeMinor: 0,
			totalMinor: 1_200_000,
			deliveryMethod: 'digital',
			pricingSnapshot: { lines: [], subtotalMinor: 1_200_000, deliveryFeeMinor: 0, totalMinor: 1_200_000, currency: 'ARS', pricedAt: '' },
			paymentProvider: 'mercadopago',
			expiresAt: clock.now
		});
		await database.insert(s.orderItems).values({
			organizationId: org,
			orderId: ids.order,
			productId: ids.product,
			variantId: ids.variant,
			name: 'Manual',
			kind: 'digital',
			quantity: 1,
			unitPriceMinor: 1_200_000,
			lineTotalMinor: 1_200_000
		});
		await database.insert(s.lookupChallenges).values({
			id: ids.challenge,
			organizationId: org,
			contactId: ids.contact,
			codeHash: 'h',
			expiresAt: new Date(clock.now.getTime() + 10 * 60_000)
		});
	});
});

afterAll(() => db.close());

describe('outbox processing', () => {
	it('emails the lookup code to the contact, opening the sealed payload', async () => {
		sent.length = 0;
		const event = await enqueue('lookup.otp', { challengeId: ids.challenge, contactId: ids.contact, sealedCode: sealSecret(keyRing, '482913', `otp:${ids.challenge}`) });
		expect(await runOnce()).toEqual(['done']);
		expect(sent).toHaveLength(1);
		expect(sent[0]!.idempotencyKey).toBe(`outbox:${event.id}`);
		expect(sent[0]!.to).toBe('juana@example.com');
		expect(sent[0]!.subject).toContain('482913');
		expect(sent[0]!.from).toBe('Taller Demo <no-reply@sortea.test>');
	});

	it('sends the purchase email with working download links on the tenant domain', async () => {
		sent.length = 0;
		await enqueue('order.paid', { orderId: ids.order });
		expect(await runOnce()).toEqual(['done']);
		const link = /https:\/\/tallerdemo\.example\/descargas\/([A-Za-z0-9_-]+)/.exec(sent[0]!.html);
		expect(link).not.toBeNull();
		const grants = await db.withTenant(org, (tx) => tx.select().from(s.downloadGrants).where(eq(s.downloadGrants.orderId, ids.order)));
		expect(grants.map((grant) => grant.tokenHash)).toContain(downloadTokenHash('pepper-for-worker-tests', link![1]!));
	});

	// Owner feedback 2026-11-11b, S2: a product with several files gets one link per file, in its order.
	it('gives each file of a product its own download link, in the order of the product', async () => {
		const product = randomUUID();
		const variant = randomUUID();
		const order = randomUUID();
		await db.withPlatform(async (database) => {
			await database.insert(s.products).values({ id: product, organizationId: org, slug: 'calcomania-digital', name: 'Calcomanía digital', description: 'PNG', kind: 'digital', status: 'active' });
			await database.insert(s.productVariants).values({ id: variant, organizationId: org, productId: product, sku: 'CD', name: 'Calcomanía digital', priceMinor: 100_000 });
			// Inserted out of order: the position decides, not the insertion.
			await database.insert(s.productAssets).values({ organizationId: org, productId: product, storagePath: 'x/b.png', filename: 'Fondo-celular.png', contentType: 'image/png', sizeBytes: 1, position: 1 });
			await database.insert(s.productAssets).values({ organizationId: org, productId: product, storagePath: 'x/a.png', filename: 'Calcomania.png', contentType: 'image/png', sizeBytes: 1, position: 0 });
			await database.insert(s.orders).values({
				id: order,
				organizationId: org,
				reference: 'MG-FILES0001',
				accessCodeHash: 'x',
				contactId: ids.contact,
				buyer: { firstName: 'Juana', lastName: 'Pérez', email: 'juana@example.com', phone: null },
				status: 'paid',
				currency: 'ARS',
				subtotalMinor: 100_000,
				deliveryFeeMinor: 0,
				totalMinor: 100_000,
				deliveryMethod: 'digital',
				pricingSnapshot: { lines: [], subtotalMinor: 100_000, deliveryFeeMinor: 0, totalMinor: 100_000, currency: 'ARS', pricedAt: '' },
				paymentProvider: 'mercadopago',
				expiresAt: clock.now
			});
			await database.insert(s.orderItems).values({ organizationId: org, orderId: order, productId: product, variantId: variant, name: 'Calcomanía digital', kind: 'digital', quantity: 1, unitPriceMinor: 100_000, lineTotalMinor: 100_000 });
		});
		sent.length = 0;
		await enqueue('order.paid', { orderId: order });
		expect(await runOnce()).toEqual(['done']);

		const html = sent[0]!.html;
		expect(html.indexOf('Descargar Calcomania.png')).toBeGreaterThan(-1);
		expect(html.indexOf('Descargar Calcomania.png')).toBeLessThan(html.indexOf('Descargar Fondo-celular.png'));
		const links = [...html.matchAll(/https:\/\/tallerdemo\.example\/descargas\/([A-Za-z0-9_-]+)/g)].map((match) => match[1]!);
		expect(new Set(links).size).toBe(2);
		const grants = await db.withTenant(org, (tx) => tx.select().from(s.downloadGrants).where(eq(s.downloadGrants.orderId, order)));
		const assets = await db.withTenant(org, (tx) => tx.select().from(s.productAssets).where(eq(s.productAssets.productId, product)));
		const byName = (name: string) => assets.find((asset) => asset.filename === name)!.id;
		const grantOf = (token: string) => grants.find((grant) => grant.tokenHash === downloadTokenHash('pepper-for-worker-tests', token))!;
		expect(links.map((token) => grantOf(token).productAssetId)).toEqual([byName('Calcomania.png'), byName('Fondo-celular.png')]);
		// Each link has its own five downloads.
		expect(grants.map((grant) => grant.maxDownloads)).toEqual([5, 5]);
		expect(sent[0]!.text).toMatch(/Descargar Calcomania\.png: https:\S+\nDescargar Fondo-celular\.png: https:\S+/);
	});

	// Owner feedback 2026-11-10 S9: the purchase email carries a ticket in the organization's style.
	it('emails a paid order with chances once, with its ticket attached and shown in the body', async () => {
		sent.length = 0;
		const campaignId = randomUUID();
		const orderId = randomUUID();
		const logoPath = `${org}/${'a'.repeat(64)}.png`;
		await db.withPlatform(async (database) => {
			await database.insert(s.campaigns).values({
				id: campaignId,
				organizationId: org,
				slug: 'moto',
				title: 'Moto 0 km',
				summary: 'Sorteo de prueba',
				status: 'open',
				timezone: 'America/Argentina/Buenos_Aires',
				opensAt: new Date('2026-10-01T00:00:00Z'),
				closesAt: new Date('2026-12-01T00:00:00Z'),
				drawAt: new Date('2026-12-13T00:00:00Z'),
				entryDigits: 4
			});
			await database.insert(s.orders).values({
				id: orderId,
				organizationId: org,
				reference: 'MG-TEST0003',
				accessCodeHash: 'x',
				contactId: ids.contact,
				buyer: { firstName: 'Juana', lastName: 'Pérez', email: 'juana@example.com', phone: '+54 9 11 2345-6789' },
				status: 'paid',
				campaignId,
				currency: 'ARS',
				subtotalMinor: 1_200_000,
				deliveryFeeMinor: 0,
				totalMinor: 1_200_000,
				deliveryMethod: 'digital',
				pricingSnapshot: { lines: [], subtotalMinor: 1_200_000, deliveryFeeMinor: 0, totalMinor: 1_200_000, currency: 'ARS', pricedAt: '' },
				paymentProvider: 'mercadopago',
				expiresAt: clock.now
			});
			await database.insert(s.orderItems).values({ organizationId: org, orderId, productId: ids.product, variantId: ids.variant, name: 'Manual', kind: 'digital', quantity: 1, unitPriceMinor: 1_200_000, lineTotalMinor: 1_200_000 });
			for (const entryNumber of [7, 8]) {
				await database.insert(s.participationEntries).values({ organizationId: org, campaignId, entryNumber, contactId: ids.contact, orderId, holderPseudonym: `p-${entryNumber}` });
			}
			// The published brand has an uploaded logo; the draft is never used.
			await database.insert(s.cmsBlocks).values({
				organizationId: org,
				key: 'brand',
				content: { logo: `media:${logoPath}`, logoAlt: 'Taller Demo', tagline: 'Taller' },
				draft: { logo: 'https://elsewhere.example/logo.png', logoAlt: 'x', tagline: 'x' },
				publishedAt: clock.now
			});
		});
		const logo = new Uint8Array(readFileSync(new URL('../../web/static/tenants/taller-demo/logo.png', import.meta.url)));
		const requested: string[] = [];
		const loadImage = async (url: string) => {
			requested.push(url);
			return { contentType: 'image/png' as const, bytes: logo };
		};

		const event = await enqueue('order.paid', { orderId });
		expect(await runOnce(undefined, { loadImage })).toEqual(['done']);
		expect(sent).toHaveLength(1);
		const email = sent[0]!;
		expect(email.idempotencyKey).toBe(`outbox:${event.id}`);
		expect(requested).toEqual([`https://tallerdemo.example/media/${logoPath}`]);
		expect(email.attachments?.map((attachment) => [attachment.filename, attachment.contentType, attachment.inlineId ?? null])).toEqual([
			['chances-MG-TEST0003.png', 'image/png', null],
			['chances-MG-TEST0003.png', 'image/png', 'ticket-MG-TEST0003-1@sortea']
		]);
		const ticket = email.attachments![0]!.content;
		expect([...ticket.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
		expect(ticket.byteLength).toBeLessThan(300_000);
		expect(Buffer.from(email.attachments![1]!.content).equals(Buffer.from(ticket))).toBe(true);
		expect(email.html).toContain('src="cid:ticket-MG-TEST0003-1@sortea"');
		expect(email.html).toContain('<strong>N.º 0007</strong>, <strong>N.º 0008</strong>');
		expect(email.text).toContain('Tus chances para Moto 0 km (2): N.º 0007, N.º 0008');

		// Processed once: the event is done and a second pass sends nothing.
		expect(await runOnce(undefined, { loadImage })).toEqual([]);
		expect(sent).toHaveLength(1);
		const notifications = await db.withTenant(org, (tx) => tx.select().from(s.notifications).where(eq(s.notifications.outboxEventId, event.id)));
		expect(notifications.map((row) => row.status)).toEqual(['sent']);
	});

	it('a ticket without a reachable logo shows the organization name, and an outside logo is never fetched', async () => {
		sent.length = 0;
		const requested: string[] = [];
		const failing = async (url: string) => {
			requested.push(url);
			return null;
		};
		const [order] = await db.withPlatform((database) => database.select({ id: s.orders.id }).from(s.orders).where(eq(s.orders.reference, 'MG-TEST0003')));
		await enqueue('order.paid', { orderId: order!.id });
		expect(await runOnce(undefined, { loadImage: failing })).toEqual(['done']);
		expect(sent[0]!.attachments).toHaveLength(2);
		expect(requested).toHaveLength(1);

		sent.length = 0;
		requested.length = 0;
		await db.withPlatform((database) => database.update(s.cmsBlocks).set({ content: { logo: 'https://elsewhere.example/logo.png', logoAlt: 'x', tagline: 'x' } }).where(eq(s.cmsBlocks.organizationId, org)));
		await enqueue('order.paid', { orderId: order!.id });
		expect(await runOnce(undefined, { loadImage: failing })).toEqual(['done']);
		expect(sent[0]!.attachments).toHaveLength(2);
		expect(requested).toEqual([]);
	});

	it('a paid order without chances carries no ticket', async () => {
		sent.length = 0;
		await enqueue('order.paid', { orderId: ids.order });
		expect(await runOnce()).toEqual(['done']);
		expect(sent[0]!.attachments ?? []).toEqual([]);
		expect(sent[0]!.html).not.toContain('cid:');
	});

	it('leaves an event alone until its available time, then processes it', async () => {
		sent.length = 0;
		// Its own times, so the clock the other tests share is never moved or rewound.
		const later = new Date(clock.now.getTime() + 3_600_000);
		await enqueue('order.paid', { orderId: ids.order }, later);
		expect(await runOnce(new Date(later.getTime() - 1))).toEqual([]);
		expect(sent).toHaveLength(0);
		expect(await runOnce(later)).toEqual(['done']);
		expect(sent).toHaveLength(1);
	});

	it('retries with backoff, records attempts and ends in dead letter', async () => {
		sent.length = 0;
		failing = true;
		const event = await enqueue('order.revoked', { orderId: ids.order });
		await db.withPlatform((database) => database.update(s.orders).set({ status: 'refunded' }).where(eq(s.orders.id, ids.order)));

		expect(await runOnce()).toEqual(['retry']);
		const [afterFirst] = await db.withPlatform((database) => database.select().from(s.outboxEvents).where(eq(s.outboxEvents.id, event.id)));
		expect(afterFirst!.status).toBe('pending');
		expect(afterFirst!.availableAt.getTime()).toBeGreaterThan(clock.now.getTime());
		expect(await runOnce()).toEqual([]);

		for (let attempt = 2; attempt <= MAX_ATTEMPTS; attempt++) {
			clock.now = new Date(clock.now.getTime() + 2 * 3_600_000);
			await runOnce();
		}
		const [final] = await db.withPlatform((database) => database.select().from(s.outboxEvents).where(eq(s.outboxEvents.id, event.id)));
		expect(final!.status).toBe('dead');
		expect(final!.lastError).toBe('smtp down');
		const attempts = await db.withTenant(org, (tx) => tx.select().from(s.notificationAttempts));
		expect(attempts.filter((attempt) => !attempt.ok)).toHaveLength(MAX_ATTEMPTS);
		failing = false;
	});

	it('every retry of one email carries the same idempotency key, so the provider sends it once', async () => {
		tried.length = 0;
		failing = true;
		const event = await enqueue('order.revoked', { orderId: ids.order });
		expect(await runOnce()).toEqual(['retry']);
		failing = false;
		clock.now = new Date(clock.now.getTime() + 2 * 3_600_000);
		expect(await runOnce()).toEqual(['done']);
		expect(tried.map((message) => message.idempotencyKey)).toEqual([`outbox:${event.id}`, `outbox:${event.id}`]);
	});

	it('an email the provider refuses for good goes to dead letter at once, without retries', async () => {
		tried.length = 0;
		rejection = new PermanentDeliveryError('Resend rejected the email (422): Invalid `to` field.');
		const event = await enqueue('order.revoked', { orderId: ids.order });
		expect(await runOnce()).toEqual(['dead']);
		const [final] = await db.withPlatform((database) => database.select().from(s.outboxEvents).where(eq(s.outboxEvents.id, event.id)));
		expect(final!.status).toBe('dead');
		expect(final!.attempts).toBe(1);
		expect(final!.lastError).toBe('Resend rejected the email (422): Invalid `to` field.');
		clock.now = new Date(clock.now.getTime() + 2 * 3_600_000);
		expect(await runOnce()).toEqual([]);
		expect(tried).toHaveLength(1);
		rejection = null;
	});

	// Owner feedback 2026-11-11b S9 (T2): the service log tells what the email provider answered.
	describe('email logs (S9)', () => {
		const logged: { level: 'info' | 'warn' | 'error'; line: string }[] = [];
		const log: NonNullable<WorkerDeps['log']> = {
			info: (line) => void logged.push({ level: 'info', line }),
			warn: (line) => void logged.push({ level: 'warn', line }),
			error: (line) => void logged.push({ level: 'error', line })
		};
		const notificationOf = async (eventId: string) => {
			const [row] = await db.withTenant(org, (tx) => tx.select().from(s.notifications).where(eq(s.notifications.outboxEventId, eventId)));
			return row!;
		};

		it('a sent email is logged at info with template, notification, outbox event and provider message id', async () => {
			logged.length = 0;
			const event = await enqueue('order.revoked', { orderId: ids.order });
			expect(await runOnce(undefined, { log })).toEqual(['done']);
			const notification = await notificationOf(event.id);
			expect(logged).toEqual([
				{
					level: 'info',
					line: `email order.revoked sent notification=${notification.id} outbox=${event.id} provider=memory message=${notification.providerMessageId}`
				}
			]);
			expect(logged.map((entry) => entry.line).join('\n')).not.toMatch(/juana|example\.com/);
		});

		it('a failed send is logged at warn with template, attempt and the provider error, without the address', async () => {
			logged.length = 0;
			failing = true;
			const event = await enqueue('order.revoked', { orderId: ids.order });
			expect(await runOnce(undefined, { log })).toEqual(['retry']);
			failing = false;
			const notification = await notificationOf(event.id);
			expect(logged).toEqual([{ level: 'warn', line: `email order.revoked failed notification=${notification.id} outbox=${event.id} provider=memory attempt=1: smtp down` }]);
		});

		it('a permanent refusal is logged at error, with any address in the provider message masked', async () => {
			logged.length = 0;
			rejection = new PermanentDeliveryError('Resend rejected the email (422): juana@example.com is not a valid address');
			const event = await enqueue('order.revoked', { orderId: ids.order });
			expect(await runOnce(undefined, { log })).toEqual(['dead']);
			rejection = null;
			const notification = await notificationOf(event.id);
			expect(logged).toEqual([
				{
					level: 'error',
					line: `email order.revoked failed notification=${notification.id} outbox=${event.id} provider=memory attempt=1: Resend rejected the email (422): ju***@*** is not a valid address`
				}
			]);
		});
	});

	it('expires unpaid orders past their window', async () => {
		const pending = randomUUID();
		await db.withPlatform((database) =>
			database.insert(s.orders).values({
				id: pending,
				organizationId: org,
				reference: 'MG-TEST0002',
				accessCodeHash: 'x',
				contactId: ids.contact,
				buyer: { firstName: 'J', lastName: 'P', email: 'j@example.com', phone: null },
				currency: 'ARS',
				subtotalMinor: 1,
				deliveryFeeMinor: 0,
				totalMinor: 1,
				deliveryMethod: 'digital',
				pricingSnapshot: { lines: [], subtotalMinor: 1, deliveryFeeMinor: 0, totalMinor: 1, currency: 'ARS', pricedAt: '' },
				paymentProvider: 'mercadopago',
				expiresAt: new Date(clock.now.getTime() - 1000)
			})
		);
		expect(await expireOrders(deps())).toBeGreaterThanOrEqual(1);
		const [row] = await db.withPlatform((database) => database.select().from(s.orders).where(eq(s.orders.id, pending)));
		expect(row!.status).toBe('expired');
		// Open dashboards hear about it (FR-OPS-02).
		const notices = await db.withTenant(org, (tx) => tx.select().from(s.opsEvents).where(eq(s.opsEvents.kind, 'order.updated')));
		expect(notices.length).toBeGreaterThanOrEqual(1);
	});

	it('drops dashboard notices older than the retention window', async () => {
		await db.withPlatform((database) =>
			database.insert(s.opsEvents).values({ organizationId: org, sequence: 1_000_000, kind: 'order.updated', createdAt: new Date(clock.now.getTime() - 8 * 86_400_000) })
		);
		// Notices written with the database clock may also fall outside the test clock's window.
		expect(await pruneOpsEvents(deps())).toBeGreaterThanOrEqual(1);
		const left = await db.withTenant(org, (tx) => tx.select().from(s.opsEvents).where(eq(s.opsEvents.sequence, 1_000_000)));
		expect(left).toEqual([]);
	});
});

// The logo the ticket shows comes from the organization's own site (S9): only images resvg draws, and small.
describe('ticket logo', () => {
	const respond = (body: ConstructorParameters<typeof Response>[0], init: ConstructorParameters<typeof Response>[1]) => (async () => new Response(body, init)) as unknown as typeof fetch;
	const png = new Uint8Array(readFileSync(new URL('../../web/static/tenants/taller-demo/logo.png', import.meta.url)));
	/** A PNG header (signature and IHDR) of the given size, closed by IEND; enough to be told apart. */
	const pngOf = (width: number, height: number) => {
		const bytes = new Uint8Array(45);
		bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
		new DataView(bytes.buffer).setUint32(16, width);
		new DataView(bytes.buffer).setUint32(20, height);
		bytes.set([8, 6, 0, 0, 0], 24);
		bytes.set([0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82], 33);
		return bytes;
	};
	/** A JPEG: SOI, an APP0 segment, a baseline SOF0 frame of the given size and EOI. */
	const jpegOf = (width: number, height: number) =>
		new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xc0, 0, 11, 8, height >> 8, height & 0xff, width >> 8, width & 0xff, 1, 1, 0x11, 0, 0xff, 0xd9]);
	const svgOf = (attributes: string) => new TextEncoder().encode(`<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" ${attributes}><rect width="10" height="10"/></svg>`);
	const url = 'https://tallerdemo.example/media/x.png';

	it('takes a PNG, JPEG or SVG logo, telling the type from its bytes and not from the declared content type', async () => {
		const jpeg = jpegOf(640, 200);
		const svg = svgOf('width="640" height="200"');
		for (const [bytes, type, declared] of [
			[png, 'image/png', 'image/png'],
			[png, 'image/png', 'application/octet-stream'],
			[jpeg, 'image/jpeg', 'image/png'],
			[svg, 'image/svg+xml', 'image/svg+xml; charset=utf-8'],
			[svg, 'image/svg+xml', 'text/plain']
		] as const) {
			const image = await fetchTicketImage(url, respond(bytes, { status: 200, headers: { 'content-type': declared } }));
			expect(image, `${type} sent as ${declared}`).toEqual({ contentType: type, bytes });
		}
	});

	it('leaves out bytes that are no PNG, JPEG or SVG, whatever their declared type', async () => {
		const webp = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x24, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20]);
		for (const bytes of [webp, new TextEncoder().encode('<html><body>no</body></html>'), png.slice(0, 12), new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a]), new TextEncoder().encode('<svg <<< not xml')]) {
			expect(await fetchTicketImage(url, respond(bytes, { status: 200, headers: { 'content-type': 'image/png' } }))).toBeNull();
		}
	});

	it('leaves out a logo wider or taller than 4096 px', async () => {
		for (const bytes of [pngOf(4097, 100), pngOf(100, 4097), jpegOf(5000, 100), jpegOf(100, 5000), svgOf('width="5000" height="100"'), svgOf('viewBox="0 0 100 9000"')]) {
			expect(await fetchTicketImage(url, respond(bytes, { status: 200, headers: { 'content-type': 'image/png' } }))).toBeNull();
		}
		for (const bytes of [pngOf(4096, 4096), jpegOf(4096, 4096), svgOf('viewBox="0 0 4096 1000"')]) {
			expect(await fetchTicketImage(url, respond(bytes, { status: 200, headers: { 'content-type': 'image/png' } }))).not.toBeNull();
		}
	});

	it('leaves out an oversized or a missing logo, and one whose site does not answer', async () => {
		expect(await fetchTicketImage(url, respond(new Uint8Array(1_000_001), { status: 200, headers: { 'content-type': 'image/png' } }))).toBeNull();
		expect(await fetchTicketImage(url, respond('no', { status: 404, headers: { 'content-type': 'image/png' } }))).toBeNull();
		expect(await fetchTicketImage(url, (async () => Promise.reject(new Error('ENOTFOUND'))) as unknown as typeof fetch)).toBeNull();
	});

	it('stops reading a body without a length once it passes 1 MB', async () => {
		let pulled = 0;
		const endless = new ReadableStream<Uint8Array>({
			pull(controller) {
				pulled += 1;
				controller.enqueue(pulled === 1 ? pngOf(10, 10) : new Uint8Array(64 * 1024));
			}
		});
		expect(await fetchTicketImage(url, respond(endless, { status: 200, headers: { 'content-type': 'image/png' } }))).toBeNull();
		// 1 MB is 16 chunks of 64 KB: the reader stops right after the cap instead of draining the stream.
		expect(pulled).toBeLessThan(20);
	});

	describe('redirects', () => {
		const servers: Server[] = [];
		const hits: Record<string, string[]> = { site: [], other: [], files: [] };
		const origins: Record<string, string> = {};
		const listen = async (name: string, handler: (path: string, response: ServerResponse) => void) => {
			const server = createServer((request, response) => {
				hits[name]!.push(request.url!);
				handler(request.url!, response);
			});
			await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
			servers.push(server);
			origins[name] = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
		};
		const image = (response: ServerResponse) => response.writeHead(200, { 'content-type': 'image/png' }).end(png);
		const redirect = (response: ServerResponse, location: string) => response.writeHead(302, { location }).end();

		beforeAll(async () => {
			await listen('other', (_path, response) => image(response));
			await listen('files', (path, response) => (path === '/again' ? redirect(response, `${origins.files}/logo.png`) : image(response)));
			await listen('site', (path, response) => {
				if (path === '/media/same') return redirect(response, '/logo.png');
				if (path === '/media/twice') return redirect(response, '/media/same');
				if (path === '/media/other') return redirect(response, `${origins.other}/logo.png`);
				if (path === '/media/files') return redirect(response, `${origins.files}/logo.png`);
				if (path === '/media/files-again') return redirect(response, `${origins.files}/again`);
				return image(response);
			});
		});
		afterAll(async () => {
			await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
		});

		it('follows one redirect on the same site', async () => {
			expect(await fetchTicketImage(`${origins.site}/media/same`)).toEqual({ contentType: 'image/png', bytes: png });
		});

		it('never contacts another origin a redirect points to', async () => {
			hits.other!.length = 0;
			hits.files!.length = 0;
			expect(await fetchTicketImage(`${origins.site}/media/other`)).toBeNull();
			// Without a files origin configured, the bucket is another origin too.
			expect(await fetchTicketImage(`${origins.site}/media/files`)).toBeNull();
			// A files origin on another port is another origin.
			expect(await fetchTicketImage(`${origins.site}/media/other`, fetch, origins.files)).toBeNull();
			expect(hits.other).toEqual([]);
			expect(hits.files).toEqual([]);
		});

		it('follows one redirect to the configured files origin (MEDIA_PUBLIC_ORIGIN), and no second one', async () => {
			expect(await fetchTicketImage(`${origins.site}/media/files`, fetch, origins.files)).toEqual({ contentType: 'image/png', bytes: png });
			hits.files!.length = 0;
			expect(await fetchTicketImage(`${origins.site}/media/files-again`, fetch, origins.files)).toBeNull();
			expect(hits.files).toEqual(['/again']);
			hits.site!.length = 0;
			expect(await fetchTicketImage(`${origins.site}/media/twice`)).toBeNull();
			expect(hits.site).toEqual(['/media/twice', '/media/same']);
		});
	});
});
