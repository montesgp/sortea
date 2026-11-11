import type { Component } from 'svelte';
import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import ProductsPage from './+page.svelte';

// S10 (odd/tasks/owner-feedback-2026-11-10.md): "Eliminar" on each row asks the server what will
// happen, and the page confirms in a second POST; archived products live under "Archivados".

const text = (html: string) =>
	html
		.replace(/<!--[\s\S]*?-->/g, '')
		.replace(/<[^>]+>/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
const session = { organization: { currency: 'ARS', timezone: 'America/Argentina/Buenos_Aires' }, permissions: ['catalog.manage'] };
const product = (id: string, name: string, status: string) => ({ id, slug: id, name, kind: 'digital', status, position: 0, variants: 1, activeVariants: 1, fromPriceMinor: 700_000, stock: null });
const page = (props: Record<string, unknown>) => render(ProductsPage as Component, { props: props as never }).body;

describe('product list (S10)', () => {
	it('offers Eliminar on each row and the Archivados tab', () => {
		const body = page({ data: { session, archived: false, list: { canManage: true, archivedCount: 2, products: [product('calco', 'Calco', 'active')] } }, form: null });
		expect(text(body)).toContain('Archivados (2)');
		expect(body).toMatch(/<form method="POST" action="\?\/confirmRemove"[^>]*>\s*<input type="hidden" name="id" value="calco"/);
		expect(body).toContain('aria-label="Eliminar Calco"');
		expect(body).not.toContain('Restaurar');
		expect(text(body)).toContain('Nuevo producto');
	});

	it('restores archived products from their tab, keeping the tab on every post', () => {
		const body = page({ data: { session, archived: true, list: { canManage: true, archivedCount: 1, products: [product('viejo', 'Viejo', 'archived')] } }, form: null });
		expect(body).toMatch(/action="\?vista=archivados&amp;\/restore"/);
		expect(body).toMatch(/action="\?vista=archivados&amp;\/confirmRemove"/);
		expect(body).toContain('aria-label="Restaurar Viejo"');
		expect(text(body)).not.toContain('Nuevo producto');
	});

	it('asks to confirm a deletion, which nothing has done yet', () => {
		const confirm = { product: { id: 'calco', name: 'Calco', status: 'active' }, outcome: 'delete', message: 'No tiene pedidos ni está en campañas: se elimina definitivamente.' };
		const body = page({ data: { session, archived: false, list: { canManage: true, archivedCount: 0, products: [product('calco', 'Calco', 'active')] } }, form: { ok: true, action: 'confirm', confirm } });
		expect(text(body)).toContain('¿Eliminar Calco? No tiene pedidos ni está en campañas: se elimina definitivamente.');
		expect(body).toMatch(/<form method="POST" action="\?\/remove"[^>]*>\s*<input type="hidden" name="id" value="calco"/);
		expect(text(body)).toContain('Eliminar definitivamente');
		expect(text(body)).toContain('Cancelar');
	});

	it('says an archive is coming instead of a deletion, and why', () => {
		const confirm = { product: { id: 'calco', name: 'Calco', status: 'active' }, outcome: 'archive', reason: 'ordered', message: 'Tiene pedidos, así que no se borra: se archiva.' };
		const body = text(page({ data: { session, archived: false, list: { canManage: true, archivedCount: 0, products: [] } }, form: { ok: true, action: 'confirm', confirm } }));
		expect(body).toContain('¿Archivar Calco? Tiene pedidos, así que no se borra: se archiva.');
		expect(body).toContain('Archivar Cancelar');
	});

	it('names the campaigns that keep a refused product, with no button to go on', () => {
		const confirm = {
			product: { id: 'manual', name: 'Manual', status: 'active' },
			outcome: 'refuse',
			reason: 'in_campaign',
			campaigns: [{ id: 'c1', title: 'Moto 0 km', status: 'open' }],
			message: 'Este producto está en la campaña «Moto 0 km».'
		};
		const body = page({ data: { session, archived: false, list: { canManage: true, archivedCount: 0, products: [] } }, form: { ok: true, action: 'confirm', confirm } });
		expect(text(body)).toContain('No se puede eliminar Manual Este producto está en la campaña «Moto 0 km».');
		expect(body).toContain('href="/admin/campanas/c1"');
		expect(body).not.toContain('action="?/remove"');
		expect(text(body)).toContain('Volver');
	});

	it('shows the result of the removal', () => {
		const body = page({ data: { session, archived: false, list: { canManage: true, archivedCount: 1, products: [] } }, form: { ok: true, action: 'remove', outcome: 'archived', message: 'Calco tiene pedidos, así que no se borra: quedó archivado.' } });
		expect(body).toMatch(/role="status"[^>]*>Calco tiene pedidos, así que no se borra: quedó archivado\./);
	});

	it('shows no actions to who cannot manage the catalog', () => {
		const body = page({ data: { session, archived: false, list: { canManage: false, archivedCount: 0, products: [product('calco', 'Calco', 'active')] } }, form: null });
		expect(body).not.toContain('confirmRemove');
	});
});
