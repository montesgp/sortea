import { createObjectStore, isLocalEndpoint, objectStoreConfigFromEnv, ObjectStoreConfigError } from '../object-store';

/**
 * Creates the local MinIO bucket named by S3_BUCKET (README, "Run it locally").
 * Local only: a deployed bucket is created once by its platform (Railway
 * Buckets) and this command refuses any other endpoint.
 *
 *   pnpm storage:init
 *
 * Running it again changes nothing.
 */
try {
	const config = objectStoreConfigFromEnv();
	if (!isLocalEndpoint(config.endpoint)) throw new ObjectStoreConfigError('Refusing to create a bucket: S3_ENDPOINT is not the local MinIO (127.0.0.1, localhost or minio).');
	const store = createObjectStore(config);
	const outcome = await store.ensureBucket();
	console.log(`${outcome === 'created' ? 'Created' : 'Already present:'} bucket ${store.location}`);
} catch (error) {
	console.error(error instanceof ObjectStoreConfigError ? error.message : error);
	process.exitCode = 1;
}
