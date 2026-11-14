import { createRawSnippet, type Component } from 'svelte';
import { render } from 'svelte/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// odd/tasks/draw-room.md T5 (S3, S4, L1): the draw room, its panel around it for the draw host
// ("Conductor del sorteo"), the broadcast mode with no personal or system data, and the clean
// "No tenés acceso" for any other panel page.
const adminApi = vi.fn();
const adminLoad = vi.fn();
vi.mock('#lib/server/admin.js', () => ({ adminApi: (...args: unknown[]) => adminApi(...args), adminLoad: (...args: unknown[]) => adminLoad(...args) }));
const page = { url: new URL('https://demo.localhost/admin/sala-de-sorteo/c1'), data: {} as Record<string, unknown>, status: 200, error: null as unknown };
vi.mock('$app/state', () => ({ page }));
vi.mock('$app/navigation', () => ({ goto: vi.fn(), invalidateAll: vi.fn() }));
vi.mock('$app/forms', () => ({ deserialize: vi.fn(), enhance: () => ({ destroy() {} }) }));

const { actions, load } = await import('./+page.server');
const Room = (await import('./+page.svelte')).default;
const PanelLayout = (await import('../../+layout.svelte')).default;
const { load: layoutLoad } = await import('../../+layout.server');
const { load: overviewLoad } = await import('../../+page.server');
const ErrorPage = (await import('../../../+error.svelte')).default;

const text = (html: string) =>
	html
		.replace(/<!--[\s\S]*?-->/g, '')
		.replace(/<[^>]+>/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
const html = (component: Component<never>, props: Record<string, unknown>) => render(component as Component, { props: props as never }).body;
const ok = (data: unknown, status = 200) => ({ ok: true, status, data });
const refused = (status: number, code: string, message: string) => ({ ok: false, status, code, message });

const hash = 'ab12cd34'.repeat(8);
const tiradaHash = 'fe98dc76'.repeat(8);
const room = (overrides: Record<string, unknown> = {}) => ({
	campaign: { id: 'c1', slug: 'moto', title: 'Sorteo Honda Wave', subtitle: 'Una moto 0 km', status: 'awarding', timezone: 'America/Argentina/Buenos_Aires', drawAt: null, entryDigits: 4, awardOrder: 'last_to_first', round: 1 },
	prizes: [
		{ id: 'moto', position: 1, title: 'Honda Wave', quantity: 1, mechanism: 'quiniela', imageUrl: 'https://cdn.example/wave.jpg' },
		{ id: 'cash', position: 2, title: '$100.000', quantity: 2, mechanism: 'quiniela', imageUrl: null }
	],
	coupons: { eligible: 294 },
	manifest: { round: 1, sha256: hash, eligibleCount: 294, publishedAt: '2026-11-29T01:00:00.000Z' },
	quinielaDraw: null,
	winners: [],
	appDraw: { tiradas: [], units: [], candidateCount: null, reason: 'Primero registrá el resultado de la Quiniela de esta ronda' },
	...overrides
});
const recorded = () =>
	room({
		quinielaDraw: { round: 1, source: 'Quiniela de la Ciudad, Nocturna', drawnAt: '2026-11-30T00:00:00.000Z', extracts: Array.from({ length: 20 }, (_, index) => 5000 + index), evidenceUrl: 'https://loteria.example/extracto.pdf' },
		winners: [
			{ prizeId: 'cash', prizeTitle: '$100.000', position: 2, slot: 1, round: 1, role: 'winner', source: 'app_draw', entryNumber: '0042', maskedName: 'Lu*** Ñ.', identity: null },
			{ prizeId: 'moto', prizeTitle: 'Honda Wave', position: 1, slot: 1, round: 1, role: 'winner', source: 'app_draw', entryNumber: '0007', maskedName: 'Ju*** P.', identity: { name: 'Juana Pérez', city: 'Cafayate', chances: 2 } }
		],
		appDraw: {
			tiradas: [
				{ round: 1, sequence: 1, attempt: 1, prizeId: 'cash', prizeTitle: '$100.000', slot: 1, drawnAt: '2026-11-30T01:15:00.000Z', candidateCount: 294, candidateSha256: tiradaHash, pick: { entryNumber: '0042', maskedName: 'Lu*** Ñ.' } },
				{ round: 1, sequence: 2, attempt: 1, prizeId: 'moto', prizeTitle: 'Honda Wave', slot: 1, drawnAt: '2026-11-30T01:20:00.000Z', candidateCount: 293, candidateSha256: tiradaHash, pick: { entryNumber: '0007', maskedName: 'Ju*** P.' } }
			],
			units: [{ prizeId: 'cash', prizeTitle: '$100.000', slot: 2, state: 'vacant' }],
			candidateCount: 292,
			reason: null
		}
	});

function actionEvent(fields: Record<string, string>, search = '') {
	const body = new URLSearchParams(fields);
	return {
		params: { id: 'c1' },
		url: new URL(`https://demo.localhost/admin/sala-de-sorteo/c1${search}`),
		request: new Request('https://demo.localhost/admin/sala-de-sorteo/c1', { method: 'POST', body })
	} as never;
}
const twenty = Array.from({ length: 20 }, (_, index) => String(5000 + index));
const details = { source: 'Quiniela de la Ciudad, Nocturna', drawDate: '29/11/2026', drawTime: '21:00', evidenceUrl: 'https://loteria.example/extracto.pdf', timezone: 'America/Argentina/Buenos_Aires' };

beforeEach(() => {
	adminApi.mockReset();
	adminLoad.mockReset();
	page.url = new URL('https://demo.localhost/admin/sala-de-sorteo/c1');
	page.data = {};
});

describe('loading the room', () => {
	it('reads the draw room API and the broadcast flag', async () => {
		adminLoad.mockResolvedValueOnce(room());
		expect(await load({ params: { id: 'c1' }, url: new URL('https://demo.localhost/admin/sala-de-sorteo/c1?transmision') } as never)).toEqual({ room: room(), broadcast: true });
		expect(adminLoad.mock.calls[0]![1]).toBe('/admin/draw-room/campaigns/c1');
	});
});

describe('the room actions', () => {
	it('matches the numbers typed so far, only the complete ones from the 1st on', async () => {
		adminApi.mockResolvedValueOnce(ok({ extracts: [], slots: [], vacant: [], holders: [], digest: null }));
		const result = await actions.coincidencias!(actionEvent({ extracts: JSON.stringify(['0042', '1234', '12', '9999']) }));
		expect(result).toMatchObject({ preview: { digest: null } });
		expect(adminApi).toHaveBeenCalledWith(expect.anything(), '/admin/campaigns/c1/quiniela/preview', { method: 'POST', body: { extracts: [42, 1234] } });
		// Nothing typed: nothing asked.
		expect(await actions.coincidencias!(actionEvent({ extracts: JSON.stringify(['', '0042']) }))).toEqual({ preview: null });
		expect(adminApi).toHaveBeenCalledTimes(1);
	});

	it('confirms only the 20 numbers with the draw data, in the campaign time zone, then records with the digest of that review', async () => {
		const short = await actions.revisar!(actionEvent({ ...details, extracts: JSON.stringify(twenty.slice(0, 19)) }));
		expect(short).toMatchObject({ status: 400, data: { message: 'Faltan números: cargá los 20 (hay 19 seguidos desde el 1.º)' } });
		const noTime = await actions.revisar!(actionEvent({ ...details, drawTime: '', extracts: JSON.stringify(twenty) }));
		expect(noTime).toMatchObject({ status: 400, data: { message: 'Indicá la fecha y la hora oficial del sorteo' } });
		expect(adminApi).not.toHaveBeenCalled();

		const body = { source: details.source, drawnAt: '2026-11-30T00:00:00.000Z', extracts: twenty.map(Number), evidenceUrl: details.evidenceUrl };
		adminApi.mockResolvedValueOnce(ok({ extracts: [], slots: [], vacant: [], digest: 'd'.repeat(64) }));
		expect(await actions.revisar!(actionEvent({ ...details, extracts: JSON.stringify(twenty) }))).toMatchObject({ review: { digest: 'd'.repeat(64) } });
		expect(adminApi.mock.calls[0]!.slice(1)).toEqual(['/admin/campaigns/c1/quiniela/preview', { method: 'POST', body }]);

		adminApi.mockResolvedValueOnce(ok(room()));
		expect(await actions.registrar!(actionEvent({ ...details, extracts: JSON.stringify(twenty), digest: 'd'.repeat(64) }))).toEqual({ recorded: true });
		expect(adminApi.mock.calls[1]!.slice(1)).toEqual(['/admin/campaigns/c1/quiniela', { method: 'POST', body: { ...body, digest: 'd'.repeat(64) } }]);
	});

	it('shows the API refusal as it says it (a draw before the manifest)', async () => {
		adminApi.mockResolvedValueOnce(refused(409, 'draw_before_manifest', 'El sorteo de la Quiniela tiene que ser posterior a la publicación del manifiesto (28/11/2026 22:00)'));
		const result = await actions.revisar!(actionEvent({ ...details, extracts: JSON.stringify(twenty) }));
		expect(result).toMatchObject({ status: 409, data: { message: 'El sorteo de la Quiniela tiene que ser posterior a la publicación del manifiesto (28/11/2026 22:00)' } });
	});

	it('draws the chosen unit once and replays a stored tirada', async () => {
		adminApi.mockResolvedValueOnce(ok({ sequence: 3 }, 201));
		expect(await actions.sortear!(actionEvent({ prizeId: 'cash', slot: '2' }))).toEqual({ tirada: { sequence: 3 } });
		expect(adminApi.mock.calls[0]!.slice(1)).toEqual(['/admin/campaigns/c1/app-draw/units', { method: 'POST', body: { prizeId: 'cash', slot: 2 } }]);
		adminApi.mockResolvedValueOnce(refused(409, 'unit_has_winner', 'Esta unidad ya tiene ganador: no se vuelve a sortear'));
		expect(await actions.sortear!(actionEvent({ prizeId: 'cash', slot: '2' }))).toMatchObject({ status: 409, data: { message: 'Esta unidad ya tiene ganador: no se vuelve a sortear' } });

		adminApi.mockResolvedValueOnce(ok({ sequence: 1 }));
		expect(await actions.tirada!(actionEvent({ sequence: '1' }))).toEqual({ tirada: { sequence: 1 }, replay: true });
		expect(adminApi.mock.calls[2]![1]).toBe('/admin/campaigns/c1/app-draw/units/1');
		expect(adminApi.mock.calls[2]![2]?.method ?? 'GET').toBe('GET');
		expect(await actions.tirada!(actionEvent({ sequence: '../x' }))).toMatchObject({ status: 400 });
		expect(adminApi).toHaveBeenCalledTimes(3);
	});

	it('looks a coupon up through the live lookup route', async () => {
		adminApi.mockResolvedValueOnce(ok({ coupon: { label: '0042' } }));
		expect(await actions.buscar!(actionEvent({ cupon: '42' }))).toEqual({ lookup: { coupon: { label: '0042' } } });
		expect(adminApi.mock.calls[0]![1]).toBe('/admin/campaigns/c1/coupon-lookup?coupon=42');
	});
});

describe('the room screen', () => {
	it('heads with the campaign, its prizes, the award order in words, the coupons and a short manifest hash', () => {
		const body = html(Room, { data: { room: room(), broadcast: false } });
		const page = text(body);
		expect(page).toContain('Sorteo Honda Wave');
		expect(page).toContain('Una moto 0 km');
		expect(page).toContain('Se adjudica del último premio al primero');
		expect(page).toContain('Cupones habilitados 294');
		expect(page).toContain('ab12cd34…ab12cd34');
		expect(page).toMatch(/\$100\.000 2 unidades/);
		expect(body).toContain('src="https://cdn.example/wave.jpg"');
	});

	it('offers the 20 positions as 4-digit numeric fields while the Quiniela is not recorded, with the draw data', () => {
		const body = html(Room, { data: { room: room(), broadcast: false } });
		for (const position of [1, 20]) expect(body).toMatch(new RegExp(`<input[^>]*id="extract-${position}"[^>]*inputmode="numeric"[^>]*maxlength="4"`));
		expect(body).not.toContain('id="extract-21"');
		expect(text(body)).toContain('1.º');
		expect(text(body)).toContain('20.º');
		expect(body).toMatch(/id="source"[^>]*value="Quiniela de la Ciudad, Nocturna"/);
		expect(body).toMatch(/id="drawDate"[^>]*placeholder="dd\/mm\/aaaa"/);
		expect(body).toContain('id="evidenceUrl"');
		expect(text(body)).toContain('Faltan 20 números para confirmar.');
		// The table lists every unit in award order before anything is matched.
		expect(text(body)).toMatch(/1\.ª \$100\.000, unidad 1 Por definir 2\.ª \$100\.000, unidad 2 Por definir 3\.ª Honda Wave Por definir/);
	});

	it('after the record lists every unit with its holder, offers the vacant one, and logs each tirada', () => {
		const body = html(Room, { data: { room: recorded(), broadcast: false } });
		const page = text(body);
		expect(body).not.toContain('id="extract-1"');
		expect(page).toMatch(/1\.ª \$100\.000, unidad 1 0042 Lu\*\*\* Ñ\. Sorteo en la app/);
		expect(page).toMatch(/2\.ª \$100\.000, unidad 2 Vacante Sortear esta posición/);
		// The consented public name, as the API sends it.
		expect(page).toMatch(/3\.ª Honda Wave 0007 Juana Pérez/);
		expect(page.match(/Sortear esta posición/g)).toHaveLength(1);
		expect(page).toContain('Registro de tiradas');
		expect(page).toContain('Tirada 1: $100.000, unidad 1');
		expect(page).toContain('Entre 294 cupones · SHA-256 fe98dc76…fe98dc76');
		expect(page).not.toContain(tiradaHash);
	});

	it('in broadcast mode shows no full hash, no URL, no copy or draw-data fields, and keeps the inputs and the draw button', () => {
		const typing = html(Room, { data: { room: room(), broadcast: true } });
		expect(typing).toContain('id="extract-1"');
		for (const hidden of ['id="source"', 'id="evidenceUrl"', 'id="drawDate"', 'Copiar', hash, 'https://loteria', 'Sala de sorteo']) expect(typing, hidden).not.toContain(hidden);
		const after = html(Room, { data: { room: recorded(), broadcast: true } });
		const page = text(after);
		expect(page).toContain('Sortear esta posición');
		for (const hidden of [hash, tiradaHash, 'https://loteria', 'loteria.example', '@', 'Copiar']) expect(after, hidden).not.toContain(hidden);
		expect(page).toContain('Salir del modo transmisión');
	});
});

// odd/tasks/draw-room.md T9 (S6, S8; ADR 0026): `app` prizes, one drand-backed tirada per prize.
const randomness = '5eed'.repeat(16);
const appTirada = (overrides: Record<string, unknown> = {}) => ({
	prizeId: 'cash',
	prizeTitle: 'Efectivo',
	round: 1,
	sequence: 1,
	attempt: 1,
	state: 'drawn',
	units: [1, 2, 3],
	drandRound: 5_000_000,
	drandRoundAt: '2026-11-30T01:15:03.000Z',
	committedAt: '2026-11-30T01:15:00.000Z',
	candidateCount: 12,
	candidateSha256: tiradaHash,
	beacon: { signature: 'ab'.repeat(48), randomness, url: 'https://api.drand.sh/52db/public/5000000' },
	picks: [
		{ slot: 1, entryNumber: '0004', maskedName: 'Ma*** G.' },
		{ slot: 2, entryNumber: '0009', maskedName: 'Pe*** R.' },
		{ slot: 3, entryNumber: '0000', maskedName: 'Ju*** P.' }
	],
	revealedAt: '2026-11-30T01:15:04.000Z',
	...overrides
});
const appPrizeList = [
	{ id: 'moto', position: 1, title: 'Moto', quantity: 1, mechanism: 'app', imageUrl: 'https://cdn.example/moto.jpg' },
	{ id: 'cash', position: 2, title: 'Efectivo', quantity: 3, mechanism: 'app', imageUrl: null }
];
const appRoom = (state: 'fresh' | 'cashDrawn' | 'motoCommitted', extra: Record<string, unknown> = {}, reason: string | null = null) => {
	const cashDrawn = state !== 'fresh';
	const cash = {
		prizeId: 'cash',
		prizeTitle: 'Efectivo',
		position: 2,
		quantity: 3,
		state: cashDrawn ? 'drawn' : 'pending',
		units: [1, 2, 3].map((slot) => ({ slot, state: cashDrawn ? 'held' : 'pending' })),
		pendingUnits: cashDrawn ? [] : [1, 2, 3],
		tiradas: cashDrawn ? [appTirada()] : [],
		reason: cashDrawn ? 'Todas las unidades de este premio ya tienen ganador: no hay nada para sortear' : null
	};
	const motoTirada = appTirada({ prizeId: 'moto', prizeTitle: 'Moto', sequence: 2, state: 'committed', units: [1], drandRound: 5_000_100, candidateCount: 9, beacon: null, picks: null, revealedAt: null });
	const moto = {
		prizeId: 'moto',
		prizeTitle: 'Moto',
		position: 1,
		quantity: 1,
		state: state === 'motoCommitted' ? 'committed' : 'pending',
		units: [{ slot: 1, state: 'pending' }],
		pendingUnits: [1],
		tiradas: state === 'motoCommitted' ? [motoTirada] : [],
		reason: null
	};
	return room({
		prizes: appPrizeList,
		winners: cashDrawn
			? [
					{ prizeId: 'cash', prizeTitle: 'Efectivo', position: 2, slot: 1, round: 1, role: 'winner', source: 'app_draw', entryNumber: '0004', maskedName: 'Ma*** G.', identity: null },
					{ prizeId: 'cash', prizeTitle: 'Efectivo', position: 2, slot: 2, round: 1, role: 'winner', source: 'app_draw', entryNumber: '0009', maskedName: 'Pe*** R.', identity: { name: 'Pedro Ruiz', city: null, chances: 3 } },
					{ prizeId: 'cash', prizeTitle: 'Efectivo', position: 2, slot: 3, round: 1, role: 'winner', source: 'app_draw', entryNumber: '0000', maskedName: 'Ju*** P.', identity: null }
				]
			: [],
		appDraw: { tiradas: [], units: [], candidateCount: null, reason: 'No hay premios vacantes para sortear en la aplicación' },
		// Award order last_to_first: the API lists the cash prize (position 2) first.
		appPrizes: { prizes: [cash, moto], candidateCount: cashDrawn ? 9 : 12, reason },
		...extra
	});
};

describe('the room with app prizes (T9)', () => {
	it('draws a prize through the API tirada route, waiting long enough for the drand round, and passes its status on', async () => {
		adminApi.mockResolvedValueOnce(ok({ sequence: 1, drandRound: 5_000_000 }, 202));
		expect(await actions.sortearPremio!(actionEvent({ prizeId: 'cash' }))).toEqual({ prizeDraw: { sequence: 1, drandRound: 5_000_000 }, status: 202 });
		expect(adminApi.mock.calls[0]!.slice(1)).toEqual(['/admin/campaigns/c1/app-draw/prizes/cash', { method: 'POST', timeoutMs: 30_000 }]);
		adminApi.mockResolvedValueOnce(ok({ sequence: 1 }, 201));
		expect(await actions.sortearPremio!(actionEvent({ prizeId: 'cash' }))).toEqual({ prizeDraw: { sequence: 1 }, status: 201 });
	});

	it('passes a refusal on as the API words it, and marks a lost answer as transient so the screen asks again', async () => {
		const pending = 'Hay una tirada de «Moto» esperando su ronda de drand: terminala con «Sortear» antes de seguir';
		adminApi.mockResolvedValueOnce(refused(409, 'app_draw_pending', pending));
		expect(await actions.sortearPremio!(actionEvent({ prizeId: 'cash' }))).toMatchObject({ status: 409, data: { message: pending, transient: false } });
		adminApi.mockResolvedValueOnce(refused(503, 'api_unreachable', 'El servicio no está disponible en este momento. Probá de nuevo en unos minutos'));
		expect(await actions.sortearPremio!(actionEvent({ prizeId: 'cash' }))).toMatchObject({ status: 503, data: { transient: true } });
		expect(await actions.sortearPremio!(actionEvent({}))).toMatchObject({ status: 400 });
		expect(adminApi).toHaveBeenCalledTimes(2);
	});

	it('lists the prizes in award order with their state, and highlights only the next one; no Quiniela entry without Quiniela prizes', () => {
		const body = html(Room, { data: { room: appRoom('fresh'), broadcast: false } });
		const page = text(body);
		expect(page).toMatch(/Premios 0 de 2 sorteados Efectivo 3 unidades Pendiente Sortear Efectivo Moto 1 unidad Pendiente Sortear Moto/);
		expect(body).toMatch(/<button[^>]*class="draw [^"]*\bprimary\b[^"]*"[^>]*>Sortear Efectivo<\/button>/);
		expect(body).toMatch(/<button[^>]*class="draw svelte-[a-z0-9]+"[^>]*>Sortear Moto<\/button>/);
		expect(body).toContain('src="https://cdn.example/moto.jpg"');
		for (const hidden of ['Números de la Quiniela', 'id="extract-1"', 'Ganadores', 'Sortear esta posición']) expect(page + body, hidden).not.toContain(hidden);
		expect(page).not.toContain('Registro de tiradas');
	});

	it('keeps the Quiniela entry for a campaign that still has Quiniela prizes', () => {
		const mixed = appRoom('fresh', { prizes: [...appPrizeList, { id: 'kit', position: 3, title: 'Kit', quantity: 1, mechanism: 'quiniela', imageUrl: null }] });
		const body = html(Room, { data: { room: mixed, broadcast: false } });
		expect(body).toContain('id="extract-1"');
		expect(text(body)).toContain('Números de la Quiniela');
		expect(text(body)).toContain('Sortear Efectivo');
	});

	it('after a tirada shows its winners and the tirada record; a pending one shows the wait with its drand round', () => {
		const body = html(Room, { data: { room: appRoom('motoCommitted'), broadcast: false } });
		const page = text(body);
		expect(page).toMatch(/Efectivo 3 unidades Sorteado 1\. 0004 Ma\*\*\* G\. 2\. 0009 Pedro Ruiz 3\. 0000 Ju\*\*\* P\./);
		expect(page).not.toContain('Sortear Efectivo');
		expect(page).toMatch(/Moto 1 unidad Comprometido: esperando el número de drand Esperando el número público de drand \(ronda 5000100\)… Sortear Moto/);
		expect(page).toContain('Registro de tiradas');
		expect(page).toContain('Tirada 1: Efectivo · 3 unidades Ronda 5000000 de drand Entre 12 cupones · SHA-256 fe98dc76…fe98dc76');
		expect(page).toContain('Tirada 2: Moto · 1 unidad Ronda 5000100 de drand · esperando el número Entre 9 cupones');
		expect(page).not.toContain(tiradaHash);
	});

	it('in broadcast mode keeps the prize list and the draw button, the drand round and the short hash, and no system data', () => {
		const body = html(Room, { data: { room: appRoom('motoCommitted', {}, 'Falta el manifiesto publicado'), broadcast: true } });
		const page = text(body);
		expect(page).toContain('Sortear Moto');
		expect(page).toContain('0009 Pedro Ruiz');
		expect(page).toContain('Esperando el número público de drand (ronda 5000100)…');
		expect(page).toContain('Ronda 5000000 de drand');
		expect(page).toContain('fe98dc76…fe98dc76');
		for (const hidden of [hash, tiradaHash, randomness, 'https://api.drand.sh', 'Copiar', 'Sala de sorteo', 'Todas las unidades de este premio', '@']) expect(body, hidden).not.toContain(hidden);
	});
});

const children = createRawSnippet(() => ({ render: () => '<p>Contenido</p>' }));
const session = (role: string, permissions: string[]) => ({
	user: { id: 'u1', email: 'host@tallerdemo.local', alias: null, assurance: 'password' },
	role,
	permissions,
	organization: { name: 'Taller Demo', slug: 'taller-demo', status: 'active', timezone: 'America/Argentina/Buenos_Aires', currency: 'ARS' }
});
const host = session('draw_host', ['draws.run']);
const owner = session('org_owner', ['dashboard.view', 'orders.view', 'campaigns.view', 'campaigns.operate', 'settings.manage', 'draws.run']);

describe('the panel around the room', () => {
	it('gives the draw host the brand, the campaign, "Mi cuenta" and "Salir", and no other section', () => {
		page.data = { room: room() };
		const body = html(PanelLayout, { data: { session: host, drawRoomOnly: true }, children });
		const shown = text(body);
		expect(shown).toContain('Taller Demo');
		expect(shown).toContain('Sorteo Honda Wave');
		expect(body).toContain('href="/admin/cuenta"');
		expect(shown).toContain('Mi cuenta');
		expect(shown).toContain('Salir');
		expect(body).toContain('action="/admin/salir"');
		for (const link of ['/admin/pedidos', '/admin/campanas', '/admin/productos', '/admin/sitio', '/admin/conciliacion', '/admin/auditoria', '/admin/configuracion', '/admin/plataforma']) {
			expect(body, link).not.toContain(link);
		}
		expect(body).not.toMatch(/class="sidebar[ "]/);
		expect(body).not.toContain('href="/admin"');
	});

	it('keeps the sidebar for the roles that manage campaigns', () => {
		const body = html(PanelLayout, { data: { session: owner, drawRoomOnly: false }, children });
		expect(body).toMatch(/class="sidebar[ "]/);
		expect(body).toContain('href="/admin/pedidos"');
	});

	it('renders nothing of the panel around the broadcast mode: no email, menus or links', () => {
		page.url = new URL('https://demo.localhost/admin/sala-de-sorteo/c1?transmision');
		for (const data of [
			{ session: host, drawRoomOnly: true },
			{ session: owner, drawRoomOnly: false }
		]) {
			const body = html(PanelLayout, { data, children });
			expect(text(body)).toBe('Contenido');
			for (const hidden of ['host@tallerdemo.local', 'Taller Demo', 'Mi cuenta', 'href=']) expect(body, hidden).not.toContain(hidden);
		}
	});

	it('refuses any other panel page to the draw host with a clean 403, and leaves the other roles alone', async () => {
		const layoutEvent = (path: string) => ({ url: new URL(`https://demo.localhost${path}`) }) as never;
		for (const path of ['/admin/pedidos', '/admin/campanas/c1', '/admin/campanas/c1/en-vivo', '/admin/plataforma']) {
			adminApi.mockResolvedValueOnce(ok(host));
			await expect(layoutLoad(layoutEvent(path)), path).rejects.toMatchObject({ status: 403, body: { code: 'draw_room_only', message: 'Esta sección no es parte de la sala de sorteo.' } });
		}
		for (const path of ['/admin', '/admin/sala-de-sorteo', '/admin/sala-de-sorteo/c1', '/admin/cuenta']) {
			adminApi.mockResolvedValueOnce(ok(host));
			expect(await layoutLoad(layoutEvent(path)), path).toEqual({ session: host, drawRoomOnly: true });
		}
		adminApi.mockResolvedValueOnce(ok(owner));
		expect(await layoutLoad(layoutEvent('/admin/pedidos'))).toEqual({ session: owner, drawRoomOnly: false });
	});

	it('sends the draw host from /admin to the room, and the others to the overview', async () => {
		await expect(overviewLoad({ parent: async () => ({ session: host }) } as never)).rejects.toMatchObject({ status: 303, location: '/admin/sala-de-sorteo' });
		adminLoad.mockResolvedValueOnce({ kpis: {} });
		expect(await overviewLoad({ parent: async () => ({ session: owner }) } as never)).toEqual({ overview: { kpis: {} } });
		expect(adminLoad.mock.calls[0]![1]).toBe('/admin/overview');
	});

	it('words the refusal as "No tenés acceso" with the way back to the room', () => {
		page.status = 403;
		page.error = { message: 'Esta sección no es parte de la sala de sorteo.', code: 'draw_room_only' };
		const body = html(ErrorPage, {});
		expect(text(body)).toContain('No tenés acceso');
		expect(body).toMatch(/href="\/admin\/sala-de-sorteo"[^>]*>Volver a la sala de sorteo/);
		page.error = { message: 'No tenés permiso para esta acción' };
		expect(html(ErrorPage, {})).toMatch(/href="\/admin"[^>]*>Volver al panel/);
		page.status = 200;
		page.error = null;
	});
});
