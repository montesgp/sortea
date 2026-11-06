import { describe, expect, it } from 'vitest';
import { paymentRedirect } from './payment-redirect';

// The checkout sends the buyer to Mercado Pago, an external origin SvelteKit 3
// refuses unless allowed; only Mercado Pago and the site itself are allowed.

const site = 'https://motogarage.com.ar';

describe('payment redirect', () => {
	it('allows Mercado Pago over https, production and sandbox', () => {
		for (const url of [
			'https://www.mercadopago.com.ar/checkout/v1/redirect?pref_id=1',
			// The checkout_url of a Checkout Pro order (Orders API).
			'https://www.mercadopago.com.ar/checkout/v1/redirect?order_id=ORD01JQ4S4KY8HWQ6NA5PXB65B3D3&pref_id=1-abc',
			'https://sandbox.mercadopago.com.ar/checkout/v1/redirect?pref_id=1',
			'https://www.mercadopago.com/checkout/v1/redirect?pref_id=1'
		]) {
			expect(paymentRedirect(url, site), url).toEqual({ location: url, external: [new URL(url).origin] });
		}
	});

	it('allows the site itself, where the local payment simulator lives', () => {
		expect(paymentRedirect(`${site}/pago-simulado?order_id=ORDSIM1`, site)).toEqual({ location: `${site}/pago-simulado?order_id=ORDSIM1`, external: [site] });
	});

	it('refuses anything else, including look-alikes and plain http', () => {
		for (const url of ['http://www.mercadopago.com.ar/checkout', 'https://mercadopago.com.ar.evil.test/x', 'https://evil.test/mercadopago.com.ar', 'javascript:alert(1)', 'not a url', 'https://localhost:5173/pago-simulado']) {
			expect(paymentRedirect(url, site), url).toBeNull();
		}
	});
});
