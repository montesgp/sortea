/** Said when an access token is pasted where the console asks for the webhook's "Clave secreta" (2026-11-10). */
export const WEBHOOK_SECRET_IS_ACCESS_TOKEN =
	'Eso es un access token, no la clave secreta del webhook. Copiala en Mercado Pago: tu aplicación → Webhooks → Configurar notificaciones → Clave secreta.';

/**
 * Why a webhook secret cannot be Mercado Pago's, or null. The secret signs
 * every notification; a credential pasted in its place would make each one
 * fail the signature check. Only access tokens can be told apart (APP_USR-,
 * TEST-); the application's Client Secret has no recognizable shape.
 */
export function webhookSecretIssue(secret: string): string | null {
	return /^(APP_USR|TEST)-/.test(secret.trim()) ? WEBHOOK_SECRET_IS_ACCESS_TOKEN : null;
}
