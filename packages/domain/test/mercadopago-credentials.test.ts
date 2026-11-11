import { describe, expect, it } from 'vitest';
import { WEBHOOK_SECRET_IS_ACCESS_TOKEN, webhookSecretIssue } from '../src';

// The console asks for Mercado Pago's webhook "Clave secreta"; an access token
// pasted there would make every notification fail its signature (2026-11-10).
describe('webhook secret guard', () => {
	it('refuses a value that is an access token, production or test', () => {
		expect(webhookSecretIssue('APP_USR-1234567890123456-111111-abcdef')).toBe(WEBHOOK_SECRET_IS_ACCESS_TOKEN);
		expect(webhookSecretIssue('TEST-1234567890123456-111111-abcdef')).toBe(WEBHOOK_SECRET_IS_ACCESS_TOKEN);
		expect(webhookSecretIssue('  APP_USR-1234567890123456  ')).toBe(WEBHOOK_SECRET_IS_ACCESS_TOKEN);
	});

	it('accepts a webhook secret as Mercado Pago shows it', () => {
		expect(webhookSecretIssue('a3f1c09b7e5d4c2a9b8e7f6d5c4b3a2918f7e6d5c4b3a291')).toBeNull();
		expect(webhookSecretIssue('whsec-connect-0123456789')).toBeNull();
	});

	it('says where the right value is, in Spanish', () => {
		expect(WEBHOOK_SECRET_IS_ACCESS_TOKEN).toBe(
			'Eso es un access token, no la clave secreta del webhook. Copiala en Mercado Pago: tu aplicación → Webhooks → Configurar notificaciones → Clave secreta.'
		);
	});
});
