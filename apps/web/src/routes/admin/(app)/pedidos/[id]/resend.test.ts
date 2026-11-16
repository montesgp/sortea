import { render } from 'svelte/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// odd/tasks/checkout-two-steps.md T3, S5: the owner or support corrects an order's email, after
// confirming it by phone, and sends its purchase email again; or sends it again as it was.
const adminApi = vi.fn();
const adminLoad = vi.fn();
vi.mock('#lib/server/admin.js', () => ({
	adminApi: (...args: unknown[]) => adminApi(...args),
	adminLoad: (...args: unknown[]) => adminLoad(...args)
}));

const { actions, load } = await import('./+page.server');
const OrderPage = (await import('./+page.svelte')).default;

const text = (html: string) =>
	html
		.replace(/<!--[\s\S]*?-->/g, '')
		.replace(/<[^>]+>/g, ' ')
		.replace(/\s+/g, ' ')
		// A tag before a full stop leaves a space the page does not show.
		.replace(/ ([.,])/g, '$1')
		.trim();

const order = {
	id: '11111111-1111-4111-8111-111111111111',
	reference: 'TD-1',
	status: 'paid',
	currency: 'ARS',
	subtotalMinor: 100,
	deliveryFeeMinor: 0,
	totalMinor: 100,
	deliveryMethod: 'digital',
	createdAt: '2026-10-25T15:00:00Z',
	paidAt: '2026-10-25T15:01:00Z',
	piiVisible: false,
	buyer: { firstName: 'Juana', lastName: 'P.', email: 'ju***@example.com', phone: null, province: null, city: null, document: null, address: null },
	items: [],
	payments: [],
	entries: [],
	entryDigits: 4,
	campaignTitle: null,
	consents: [],
	resendable: true
};

const session = (permissions: string[]) => ({ organization: { timezone: 'America/Argentina/Buenos_Aires' }, permissions });

const page = (options: { permissions?: string[]; form?: Record<string, unknown> | null; resent?: boolean; order?: Record<string, unknown> } = {}) =>
	render(OrderPage, {
		props: { data: { order: { ...order, ...options.order }, session: session(options.permissions ?? ['orders.view', 'orders.resend']), resent: options.resent ?? false }, form: options.form ?? null } as never
	}).body;

const section = (html: string) => /<section class="panel[^"]*" id="reenviar">[\s\S]*?<\/section>/.exec(html)?.[0] ?? null;

function fakeEvent(form: Record<string, string>, search = '') {
	return {
		params: { id: order.id },
		url: new URL(`https://demo.localhost/admin/pedidos/${order.id}${search}`),
		request: new Request(`https://demo.localhost/admin/pedidos/${order.id}?/resend`, { method: 'POST', body: new URLSearchParams(form) })
	} as never;
}

beforeEach(() => {
	adminApi.mockReset();
	adminLoad.mockReset();
});

describe('"Reenviar la compra" section', () => {
	it('shows with orders.resend: the current email and an optional corrected email', () => {
		const html = section(page())!;
		expect(html).not.toBeNull();
		expect(text(html)).toContain('Reenviar la compra');
		expect(text(html)).toContain('Email actual: ju***@example.com');
		expect(html).toMatch(/<form method="POST" action="\?\/resend"/);
		expect(html).toMatch(/<label for="resend-email">Corregir el email/);
		expect(html).toMatch(/<input id="resend-email" type="email" name="email"[^>]*>/);
		expect(html).not.toMatch(/<input id="resend-email"[^>]*required/);
		expect(html).not.toContain('name="confirm"');
	});

	it('is hidden without the permission', () => {
		expect(section(page({ permissions: ['orders.view'] }))).toBeNull();
		expect(page({ permissions: ['orders.view', 'orders.pii'] })).not.toContain('?/resend');
	});

	it('says why an order without a purchase email cannot be resent, with no form', () => {
		const html = section(page({ order: { status: 'pending_payment', resendable: false } }))!;
		expect(text(html)).toContain('Esta compra no tiene un email de compra para reenviar: solo se reenvían las compras pagadas.');
		expect(html).not.toContain('<form');
	});

	it('asks for confirmation with the destination, carrying the corrected email and the request id', () => {
		const requestId = '22222222-2222-4222-8222-222222222222';
		const html = section(page({ form: { action: 'resend', confirm: true, email: 'juana@example.com', requestId } }))!;
		expect(text(html)).toContain('Vas a enviar el comprobante, las descargas y los cupones a juana@example.com. ¿Seguimos?');
		expect(html).toContain('<input type="hidden" name="confirm" value="yes"');
		expect(html).toContain(`<input type="hidden" name="requestId" value="${requestId}"`);
		expect(html).toContain('<input type="hidden" name="email" value="juana@example.com"');
		expect(html).toMatch(/<button class="button[^"]*">Sí, enviar<\/button>/);
		expect(html).toMatch(new RegExp(`<a class="button[^"]*" href="/admin/pedidos/${order.id}">Cancelar</a>`));
	});

	it('confirms a plain resend to the current email', () => {
		const html = section(page({ form: { action: 'resend', confirm: true, email: '', requestId: '22222222-2222-4222-8222-222222222222' } }))!;
		expect(text(html)).toContain('Vas a enviar el comprobante, las descargas y los cupones a ju***@example.com. ¿Seguimos?');
		expect(html).not.toContain('name="email"');
	});

	it('shows the success notice after the redirect, and the error of a refused resend', () => {
		expect(text(section(page({ resent: true }))!)).toContain('Listo: el email de la compra sale en unos minutos, con el comprobante, las descargas y los cupones.');
		const refused = section(page({ form: { action: 'resend', ok: false, email: 'otra@example.com', message: 'Ya reenviaste esta compra 5 veces en las últimas 24 horas. Probá de nuevo más tarde.' } }))!;
		expect(refused).toMatch(/<p class="notice error" role="alert">Ya reenviaste esta compra 5 veces/);
		// The typed email stays in the field.
		expect(refused).toMatch(/<input id="resend-email"[^>]*value="otra@example.com"/);
	});
});

describe('resend action', () => {
	it('the first post only asks for confirmation, with the email trimmed and lowercased and a fresh request id', async () => {
		const first = (await actions.resend(fakeEvent({ email: '  Juana@Example.COM ' }))) as Record<string, unknown>;
		expect(first).toMatchObject({ action: 'resend', confirm: true, email: 'juana@example.com' });
		expect(first.requestId).toMatch(/^[0-9a-f-]{36}$/);
		const second = (await actions.resend(fakeEvent({ email: '' }))) as Record<string, unknown>;
		expect(second).toMatchObject({ action: 'resend', confirm: true, email: '' });
		expect(second.requestId).not.toBe(first.requestId);
		expect(adminApi).not.toHaveBeenCalled();
	});

	it('refuses an invalid email before confirming', async () => {
		const result = (await actions.resend(fakeEvent({ email: 'juana@' }))) as { status: number; data: unknown };
		expect(result).toMatchObject({ status: 400, data: { action: 'resend', ok: false, email: 'juana@', message: 'Ingresá un email válido' } });
		expect(adminApi).not.toHaveBeenCalled();
	});

	it('the confirmed post resends through the API and redirects (303), so a reload does not post again', async () => {
		adminApi.mockResolvedValue({ ok: true, status: 200, data: { to: 'ju***@example.com', emailCorrected: true, resendsLeft: 4 } });
		const requestId = '33333333-3333-4333-8333-333333333333';
		const event = fakeEvent({ confirm: 'yes', email: 'juana@example.com', requestId });
		await expect(actions.resend(event)).rejects.toMatchObject({ status: 303, location: `/admin/pedidos/${order.id}?reenvio=listo` });
		expect(adminApi).toHaveBeenCalledWith(event, `/admin/orders/${order.id}/resend`, { method: 'POST', body: { requestId, email: 'juana@example.com' } });
	});

	it('a confirmed plain resend sends no email field', async () => {
		adminApi.mockResolvedValue({ ok: true, status: 200, data: { to: 'ju***@example.com', emailCorrected: false, resendsLeft: 4 } });
		const requestId = '44444444-4444-4444-8444-444444444444';
		const event = fakeEvent({ confirm: 'yes', requestId });
		await expect(actions.resend(event)).rejects.toMatchObject({ status: 303 });
		expect(adminApi).toHaveBeenCalledWith(event, `/admin/orders/${order.id}/resend`, { method: 'POST', body: { requestId } });
	});

	it("reports the API's refusal in place", async () => {
		adminApi.mockResolvedValue({ ok: false, status: 429, code: 'resend_limit', message: 'Ya reenviaste esta compra 5 veces en las últimas 24 horas. Probá de nuevo más tarde.' });
		const result = (await actions.resend(fakeEvent({ confirm: 'yes', requestId: '55555555-5555-4555-8555-555555555555' }))) as { status: number; data: unknown };
		expect(result).toMatchObject({ status: 429, data: { action: 'resend', ok: false, message: 'Ya reenviaste esta compra 5 veces en las últimas 24 horas. Probá de nuevo más tarde.' } });
	});
});

describe('order page load', () => {
	it('reads the notice of a resend from the address it redirected to', async () => {
		adminLoad.mockResolvedValue(order);
		expect(await load(fakeEvent({}, '?reenvio=listo'))).toEqual({ order, resent: true });
		expect(await load(fakeEvent({}))).toEqual({ order, resent: false });
		expect(adminLoad).toHaveBeenCalledWith(expect.anything(), `/admin/orders/${order.id}`);
	});
});
