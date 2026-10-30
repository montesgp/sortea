import { eq, schema as s, type Tx } from '@sortea/db';
import { publicContact, publicSocial, type PublicContact, type SocialLinks } from '@sortea/domain';
import { notFound } from './errors';

/**
 * Sets or clears the organization's WhatsApp number (digits, as wa.me expects)
 * without touching the rest of its settings. Shared by the organization's own
 * settings page and the platform console (S5). Callers audit and invalidate
 * the tenant cache.
 */
export async function saveWhatsApp(tx: Tx, organizationId: string, whatsapp: string | null, now: Date): Promise<PublicContact> {
	const [org] = await tx.select({ settings: s.organizations.settings }).from(s.organizations).where(eq(s.organizations.id, organizationId)).for('update');
	if (!org) throw notFound('Organización');
	const { whatsapp: _previous, ...rest } = org.settings.contact;
	const contact = whatsapp ? { ...rest, whatsapp } : rest;
	await tx.update(s.organizations).set({ settings: { ...org.settings, contact }, updatedAt: now }).where(eq(s.organizations.id, organizationId));
	return publicContact(contact);
}

/**
 * Sets or clears the organization's Google Maps link (S3, feedback 2026-10-30)
 * without touching the rest of its settings. Callers audit and invalidate the
 * tenant cache.
 */
export async function saveMapsUrl(tx: Tx, organizationId: string, mapsUrl: string | null, now: Date): Promise<PublicContact> {
	const [org] = await tx.select({ settings: s.organizations.settings }).from(s.organizations).where(eq(s.organizations.id, organizationId)).for('update');
	if (!org) throw notFound('Organización');
	const { mapsUrl: _previous, ...rest } = org.settings.contact;
	const contact = mapsUrl ? { ...rest, mapsUrl } : rest;
	await tx.update(s.organizations).set({ settings: { ...org.settings, contact }, updatedAt: now }).where(eq(s.organizations.id, organizationId));
	return publicContact(contact);
}

/**
 * Replaces the organization's social links (S8, 2026-10-18) without touching
 * the rest of its settings. Shared by the organization's settings page and the
 * platform console. Callers audit and invalidate the tenant cache.
 */
export async function saveSocial(tx: Tx, organizationId: string, social: SocialLinks, now: Date): Promise<SocialLinks> {
	const [org] = await tx.select({ settings: s.organizations.settings }).from(s.organizations).where(eq(s.organizations.id, organizationId)).for('update');
	if (!org) throw notFound('Organización');
	await tx.update(s.organizations).set({ settings: { ...org.settings, social }, updatedAt: now }).where(eq(s.organizations.id, organizationId));
	return publicSocial(social);
}
