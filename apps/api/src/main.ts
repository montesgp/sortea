import { createDatabase } from '@sortea/db';
import { parseKeyRing } from '@sortea/domain/server';
import { buildApp } from './app';
import { loadConfig } from './config';
import { supabaseTokenVerifier } from './lib/admin-auth';
import { createMercadoPagoProvider } from './payments/mercadopago';
import { createPaymentSimulator } from './payments/simulator';
import { createSupabaseMediaStorage, createSupabaseStorage } from './storage';

const config = loadConfig();
const db = createDatabase(config.DATABASE_URL);
const simulator = config.PAYMENTS_FAKE_PROVIDER ? createPaymentSimulator({ webOrigin: config.WEB_FALLBACK_ORIGIN }) : null;

const app = await buildApp(
	{
		config,
		db,
		keyRing: parseKeyRing(config.SECRETS_KEY_RING),
		payments: simulator ?? createMercadoPagoProvider(),
		simulator,
		storage: createSupabaseStorage(config.SUPABASE_URL, config.SUPABASE_SECRET_KEY, config.STORAGE_BUCKET),
		media: createSupabaseMediaStorage(config.SUPABASE_URL, config.SUPABASE_SECRET_KEY, config.MEDIA_BUCKET),
		verifyAdminToken: supabaseTokenVerifier(config.SUPABASE_URL),
		now: () => new Date()
	},
	{ logger: true }
);

const shutdown = async () => {
	await app.close();
	await db.close();
	process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await app.listen({ port: config.API_PORT, host: '0.0.0.0' });
if (simulator) app.log.warn('Payment simulator enabled: payments are not real');
