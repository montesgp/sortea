import { describe, expect, it } from 'vitest';
import { canChangeProductKind, canRemovePrize, canSetProductStatus, prizeInputSchema, prizesEditable, productInputSchema, variantInputSchema } from '../src';

describe('product administration', () => {
	it('activates a product only when it has something to sell', () => {
		expect(canSetProductStatus('draft', 'active', 0)).toEqual({ ok: false, reason: 'needs_active_variant' });
		expect(canSetProductStatus('draft', 'active', 1)).toEqual({ ok: true });
		expect(canSetProductStatus('active', 'archived', 1)).toEqual({ ok: true });
		expect(canSetProductStatus('archived', 'active', 1)).toEqual({ ok: false, reason: 'invalid_transition' });
		expect(canSetProductStatus('archived', 'draft', 0)).toEqual({ ok: true });
	});

	it('freezes the kind once the product was ordered', () => {
		expect(canChangeProductKind(false)).toBe(true);
		expect(canChangeProductKind(true)).toBe(false);
	});

	it('validates slugs, prices and availability windows', () => {
		expect(productInputSchema.safeParse({ slug: ' Manual-Tecnico ', name: 'Manual', description: 'Manual técnico en PDF', kind: 'digital' }).data?.slug).toBe('manual-tecnico');
		expect(productInputSchema.safeParse({ slug: 'manual técnico', name: 'Manual', description: 'Manual técnico en PDF', kind: 'digital' }).success).toBe(false);
		expect(productInputSchema.safeParse({ slug: 'm1', name: 'Manual', description: 'Manual técnico en PDF', kind: 'digital', imageUrl: 'http://x.test/a.jpg' }).success).toBe(false);
		expect(productInputSchema.safeParse({ slug: 'm1', name: 'Manual', description: 'Manual técnico en PDF', kind: 'digital', imageUrl: '/tenants/motogarage/taller.jpg' }).success).toBe(true);

		const variant = { sku: 'MAN-01', name: 'PDF', priceMinor: 1_200_000, stock: null, maxPerOrder: 5 };
		expect(variantInputSchema.safeParse(variant).success).toBe(true);
		expect(variantInputSchema.safeParse({ ...variant, priceMinor: 0 }).success).toBe(false);
		expect(variantInputSchema.safeParse({ ...variant, priceMinor: 12.5 }).success).toBe(false);
		expect(variantInputSchema.safeParse({ ...variant, availableFrom: '2026-11-01', availableUntil: '2026-10-01' }).success).toBe(false);
	});
});

describe('prize administration', () => {
	it('allows editing prizes only until the campaign opens (FR-CAMP-06)', () => {
		expect(prizesEditable('draft')).toBe(true);
		expect(prizesEditable('published')).toBe(true);
		expect(prizesEditable('open')).toBe(false);
		expect(prizesEditable('awarding')).toBe(false);
	});

	it('keeps at least one prize on a published campaign', () => {
		expect(canRemovePrize('draft', 1)).toBe(true);
		expect(canRemovePrize('published', 1)).toBe(false);
		expect(canRemovePrize('published', 2)).toBe(true);
		expect(canRemovePrize('open', 5)).toBe(false);
	});

	it('validates value, quantity and alternates', () => {
		const prize = { kind: 'cash', title: '$100.000 en efectivo', declaredValueMinor: 10_000_000, quantity: 10, alternatesCount: 1 };
		expect(prizeInputSchema.safeParse(prize).success).toBe(true);
		expect(prizeInputSchema.safeParse({ ...prize, quantity: 0 }).success).toBe(false);
		expect(prizeInputSchema.safeParse({ ...prize, alternatesCount: 11 }).success).toBe(false);
		expect(prizeInputSchema.safeParse({ ...prize, kind: 'raffle' }).success).toBe(false);
	});
});
