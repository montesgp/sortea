import { whatsappLink } from '@sortea/domain';

export const WHATSAPP_GREETING = 'Hola, vengo desde la web';

/** Chat link for the organization's WhatsApp number, or null when it has none (S5). */
export function whatsappHref(number: string | undefined): string | null {
	return whatsappLink(number, WHATSAPP_GREETING);
}
