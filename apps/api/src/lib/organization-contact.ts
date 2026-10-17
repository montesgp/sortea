import { eq, schema as s, type Tx } from '@sortea/db';
import { publicContact, type PublicContact } from '@sortea/domain';
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
