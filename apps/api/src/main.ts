import { createDatabase } from '@sortea/db';
import { createObjectStore } from '@sortea/db/object-store';
import { parseKeyRing } from '@sortea/domain/server';
import { buildApp } from './app';
import { loadConfig } from './config';
import { createDrandClient, parseRelays } from './lib/drand';
import { listenDualStack } from './listen';
import { createMercadoPagoProvider } from './payments/mercadopago';
import { createPaymentSimulator } from './payments/simulator';
import { createS3FileStorage, createS3MediaStorage } from './storage';

const config = loadConfig();
const db = createDatabase(config.DATABASE_URL);
const bucket = createObjectStore({
	endpoint: config.S3_ENDPOINT ?? null,
	region: config.S3_REGION,
	bucket: config.S3_BUCKET,
	accessKeyId: config.S3_ACCESS_KEY_ID,
	secretAccessKey: config.S3_SECRET_ACCESS_KEY,
	forcePathStyle: config.S3_FORCE_PATH_STYLE
});
const simulator = config.PAYMENTS_FAKE_PROVIDER ? createPaymentSimulator({ webOrigin: config.WEB_FALLBACK_ORIGIN }) : null;

const app = await buildApp(
	{
		config,
		db,
		keyRing: parseKeyRing(config.SECRETS_KEY_RING),
		// The provider only warns after the app exists, so the warning can use its logger.
		payments: simulator ?? createMercadoPagoProvider(fetch, () => new Date(), (message, details) => {
			try {
				app.log.warn(details, message);
			} catch {
				// A logging failure must never fail the order read that only wanted to warn.
			}
		}),
		simulator,
		storage: createS3FileStorage(bucket),
		media: createS3MediaStorage(bucket),
		now: () => new Date(),
		drand: createDrandClient({
			relays: parseRelays(config.DRAND_RELAYS),
			onRelayError: (relay, reason) => app.log.warn({ relay, reason }, 'drand relay did not give the round')
		})
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

await listenDualStack(app, config.API_PORT, config.API_HOST);
if (simulator) app.log.warn('Payment simulator enabled: payments are not real');
// The web must allow this origin for redirects and in its CSP (MEDIA_PUBLIC_ORIGIN, README "Deploy").
app.log.info({ bucket: bucket.location, origin: bucket.origin }, 'Files are served from the S3 bucket');
