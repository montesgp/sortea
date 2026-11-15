import { formatEntryNumber, formatMoney, type CurrencyCode } from '@sortea/domain';
import type { EmailAttachment } from './notifications';

export interface Rendered {
	readonly subject: string;
	readonly html: string;
	readonly text: string;
	readonly attachments?: readonly EmailAttachment[];
}

interface Brand {
	readonly name: string;
	readonly accent: string;
	readonly origin: string;
	/** The published logo as a PNG or JPEG on the organization's site; null shows the name (S7). */
	readonly logoUrl?: string | null;
}

const escape = (value: string) =>
	value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);

function layout(brand: Brand, title: string, body: string): string {
	return `<!doctype html><html lang="es"><body style="margin:0;background:#f3f3f1;font-family:Arial,Helvetica,sans-serif;color:#141414">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:8px;overflow:hidden">
<tr><td style="background:#141414;color:#ffffff;padding:20px 28px;font-size:18px;font-weight:bold;border-bottom:4px solid ${brand.accent}">${header(brand)}</td></tr>
<tr><td style="padding:28px">
<h1 style="font-size:22px;margin:0 0 16px">${escape(title)}</h1>
${body}
</td></tr>
<tr><td style="padding:16px 28px;font-size:12px;color:#5b5b5b;background:#fafafa">Este correo se envió porque hiciste una operación en ${escape(brand.origin.replace(/^https?:\/\//, ''))}. No respondas a este mensaje.</td></tr>
</table></td></tr></table></body></html>`;
}

/** The organization's logo heads the email (owner feedback 2026-11-15 S7); its name when there is none. */
function header(brand: Brand): string {
	if (!brand.logoUrl) return escape(brand.name);
	return `<img src="${escape(brand.logoUrl)}" alt="${escape(brand.name)}" height="56" style="display:block;height:56px;width:auto;border:0">`;
}

function button(href: string, label: string, accent: string): string {
	return `<a href="${escape(href)}" style="display:inline-block;background:${accent};color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:6px;font-weight:bold">${escape(label)}</a>`;
}

export function otpEmail(brand: Brand, code: string, minutes: number): Rendered {
	return {
		subject: `Tu código de consulta: ${code}`,
		html: layout(
			brand,
			'Tu código para consultar tus compras',
			`<p style="font-size:15px;line-height:1.5">Ingresalo en la página de consulta. Vence en ${minutes} minutos y sirve una sola vez.</p>
<p style="font-size:34px;letter-spacing:8px;font-weight:bold;margin:24px 0">${escape(code)}</p>
<p style="font-size:13px;color:#5b5b5b">Si no pediste este código, ignorá este correo: nadie puede ver tus datos sin él.</p>`
		),
		text: `Tu código de consulta en ${brand.name} es ${code}. Vence en ${minutes} minutos y sirve una sola vez. Si no lo pediste, ignorá este correo.`
	};
}

export interface PaidOrderView {
	readonly reference: string;
	readonly firstName: string;
	readonly currency: CurrencyCode;
	readonly totalMinor: number;
	readonly items: readonly { name: string; quantity: number; lineTotalMinor: number }[];
	readonly downloads: readonly { filename: string; url: string }[];
	/**
	 * Coupons per campaign, padded to its `entryDigits` when shown (ADR 0014 §1), with the
	 * campaign's ticket (a PNG) when it could be rendered (owner feedback 2026-11-10 S9).
	 */
	readonly entries: readonly { campaign: string; numbers: readonly number[]; entryDigits: number; ticket?: Uint8Array }[];
	readonly deliveryMethod: 'digital' | 'pickup' | 'shipping';
	readonly downloadHours: number;
}

const chances = (count: number) => (count === 1 ? '1 chance' : `${count} chances`);

/**
 * Each ticket goes once, as the inline image the body shows (`cid:`), which the buyer saves on the
 * phone; sent also as a download it showed twice in mail viewers (owner feedback 2026-11-15 S6).
 * A client that shows no images still has the list of coupons below it.
 */
function ticketsOf(order: PaidOrderView) {
	const withTicket = order.entries.filter((group) => group.ticket);
	return new Map(
		withTicket.map((group, index) => {
			const suffix = withTicket.length > 1 ? `-${index + 1}` : '';
			return [group, { filename: `chances-${order.reference}${suffix}.png`, inlineId: `ticket-${order.reference}-${index + 1}@sortea`, content: group.ticket! }] as const;
		})
	);
}

export function orderPaidEmail(brand: Brand, order: PaidOrderView): Rendered {
	const money = (minor: number) => formatMoney({ amountMinor: minor, currency: order.currency });
	const tickets = ticketsOf(order);
	const ticketHtml = (group: PaidOrderView['entries'][number]) => {
		const ticket = tickets.get(group);
		if (!ticket) return '';
		return `<p style="margin:12px 0 4px"><img src="cid:${escape(ticket.inlineId)}" alt="Ticket con tus chances para ${escape(group.campaign)}" width="504" style="display:block;width:100%;max-width:504px;height:auto;border:0;border-radius:8px"></p>
<p style="font-size:13px;color:#5b5b5b;margin:0 0 12px">Guardá esta imagen en tu teléfono: es tu ticket.</p>`;
	};
	const rows = order.items
		.map((item) => `<tr><td style="padding:6px 0">${escape(item.name)} × ${item.quantity}</td><td align="right">${money(item.lineTotalMinor)}</td></tr>`)
		.join('');
	const downloads = order.downloads.length
		? `<h2 style="font-size:16px;margin:24px 0 8px">Tus archivos</h2>
<p style="font-size:13px;color:#5b5b5b">Los enlaces vencen en ${order.downloadHours} horas. Después podés pedir enlaces nuevos desde Consultar.</p>
${order.downloads.map((download) => `<p>${button(download.url, `Descargar ${download.filename}`, brand.accent)}</p>`).join('')}`
		: '';
	const entries = order.entries.length
		? `<h2 style="font-size:16px;margin:24px 0 8px">Tus chances</h2>
<p style="font-size:13px;color:#5b5b5b">Cada chance es un cupón numerado para el sorteo.</p>
${order.entries.map((group) => `${ticketHtml(group)}<p style="margin:4px 0">${escape(group.campaign)}: ${chances(group.numbers.length)} ${group.numbers.map((number) => `<strong>${formatEntryNumber(number, group.entryDigits)}</strong>`).join(', ')}</p>`).join('')}`
		: '';
	const delivery =
		order.deliveryMethod === 'pickup'
			? '<p style="font-size:14px">Te vamos a contactar para coordinar el retiro.</p>'
			: order.deliveryMethod === 'shipping'
				? '<p style="font-size:14px">Te avisamos cuando despachemos el envío.</p>'
				: '';
	return {
		subject: `Compra confirmada ${order.reference}`,
		html: layout(
			brand,
			`¡Gracias, ${order.firstName}! Tu pago está confirmado`,
			`<p style="font-size:14px;color:#5b5b5b">Comprobante ${escape(order.reference)}</p>
<table role="presentation" width="100%" style="font-size:14px;border-collapse:collapse">${rows}
<tr><td style="padding-top:10px;border-top:1px solid #e3e3e3;font-weight:bold">Total</td><td align="right" style="padding-top:10px;border-top:1px solid #e3e3e3;font-weight:bold">${money(order.totalMinor)}</td></tr></table>
${delivery}${downloads}${entries}
<p style="margin-top:24px">${button(`${brand.origin}/consulta`, 'Consultar mis compras', '#141414')}</p>`
		),
		text: [
			`Tu pago está confirmado. Comprobante ${order.reference}.`,
			...order.items.map((item) => `- ${item.name} × ${item.quantity}: ${money(item.lineTotalMinor)}`),
			`Total: ${money(order.totalMinor)}`,
			...order.downloads.map((download) => `Descargar ${download.filename}: ${download.url}`),
			...order.entries.map((group) => `Tus chances para ${group.campaign} (${group.numbers.length}): ${group.numbers.map((number) => formatEntryNumber(number, group.entryDigits)).join(', ')}`),
			`Consultá tus compras en ${brand.origin}/consulta`
		].join('\n'),
		...(tickets.size
			? {
					attachments: [...tickets.values()].map((ticket) => ({ filename: ticket.filename, contentType: 'image/png', content: ticket.content, inlineId: ticket.inlineId }))
				}
			: {})
	};
}

export function orderRevokedEmail(brand: Brand, reference: string, reason: 'refunded' | 'charged_back'): Rendered {
	const what = reason === 'refunded' ? 'se reintegró' : 'tuvo un contracargo';
	return {
		subject: `Novedad sobre tu compra ${reference}`,
		html: layout(
			brand,
			'Actualizamos el estado de tu compra',
			`<p style="font-size:15px;line-height:1.5">El pago de la compra ${escape(reference)} ${what}. Las participaciones asociadas quedaron anuladas y el historial se conserva.</p>
<p>${button(`${brand.origin}/consulta`, 'Ver mis compras', brand.accent)}</p>`
		),
		text: `El pago de la compra ${reference} ${what}. Las participaciones asociadas quedaron anuladas. Consultá en ${brand.origin}/consulta`
	};
}
