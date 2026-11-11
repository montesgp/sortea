import QRCode from 'qrcode';

/**
 * The TOTP enrolment QR code as SVG, drawn by the API so the secret never goes
 * to a third-party service (ADR 0020). Error correction M with the standard
 * four-module quiet zone, black on white so it scans on the dark theme too.
 */
export async function qrSvg(text: string): Promise<string> {
	return QRCode.toString(text, { type: 'svg', errorCorrectionLevel: 'M', margin: 4, width: 240, color: { dark: '#000000', light: '#ffffff' } });
}
