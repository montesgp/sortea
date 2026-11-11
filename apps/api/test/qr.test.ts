import QRCode from 'qrcode';
import { describe, expect, it } from 'vitest';
import { qrSvg } from '../src/lib/qr';

// The TOTP enrolment QR is drawn by the API (ADR 0020).
describe('enrolment QR code', () => {
	const uri = 'otpauth://totp/demo.localhost:owner%40tallerdemo.local?secret=MZXW6YTBOIMZXW6YTBOIMZXW6YTBOIMZ&issuer=demo.localhost&algorithm=SHA1&digits=6&period=30';

	it('renders a standalone SVG on white, without scripts', async () => {
		const svg = await qrSvg(uri);
		expect(svg).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="240" height="240" viewBox="0 0 \d+ \d+"/);
		expect(svg).toContain('fill="#ffffff"');
		expect(svg).not.toMatch(/<script|\son\w+=|href=/i);
	});

	it('uses error correction M and a version a phone reads from the screen', () => {
		const qr = QRCode.create(uri, { errorCorrectionLevel: 'M' });
		// Level M is encoded as 0 in the format bits (L=1, M=0, Q=3, H=2).
		expect(qr.errorCorrectionLevel.bit).toBe(0);
		expect(qr.version).toBeLessThanOrEqual(10);
	});
});
