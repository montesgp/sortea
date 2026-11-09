import type { ClientPack } from '../client-pack';

/**
 * Pista Sur: a fictional second organization that proves theming and isolation
 * (AC-02, AC-10). The seed brings it back when it is missing (ADR 0011).
 */
export const pistaSurPack: ClientPack = {
	slug: 'pista-sur',
	name: 'Pista Sur',
	orderPrefix: 'PS',
	hosts: ['pista.localhost'],
	settings: {
		contact: { city: 'Tenant de demostración' },
		social: {},
		delivery: { pickupEnabled: true, shippingEnabled: false, shippingFeeMinor: 0 },
		legal: { termsVersion: '2026-10-draft', privacyVersion: '2026-10-draft' }
	},
	theme: {
		defaultMode: 'light',
		light: {
			bg: '#F4F7FB',
			surface: '#FFFFFF',
			surface2: '#E6EDF6',
			text: '#0B1B33',
			muted: '#46566E',
			border: '#C9D5E5',
			accent: '#1747C9',
			accentText: '#FFFFFF',
			success: '#0F7A5C',
			warning: '#8A5A00',
			danger: '#B42318'
		},
		dark: { accent: '#F2C230', accentText: '#0B1B33' },
		radius: 18,
		fontDisplay: 'inter-tight',
		fontBody: 'inter-tight',
		density: 'comfortable'
	},
	members: [{ email: 'owner@pistasur.local', role: 'org_owner' }],
	blocks: [
		{ key: 'brand', content: { logo: null, logoAlt: 'Pista Sur', tagline: 'Tenant de demostración de la plataforma.' } },
		{
			key: 'home',
			content: {
				heroTitle: 'Pista Sur',
				heroLead: 'Segundo tenant de demostración: mismo código, otra marca, otros datos.',
				heroImage: null,
				services: [],
				process: [],
				ctaTitle: 'Tenant de demostración',
				ctaBody: 'Sirve para probar el aislamiento entre organizaciones y el cambio de tema.'
			}
		}
	],
	products: [{ slug: 'pase-anual', name: 'Pase anual de socios', description: 'Producto de demostración.', kind: 'digital', priceMinor: 4_500_000, sku: 'PS-PASS', asset: true }]
};
