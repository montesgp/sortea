export function databaseUrl(): string {
	return process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
}

/** A database on this machine or in the local Docker network. */
export function isLocalDatabase(url: string): boolean {
	return ['127.0.0.1', 'localhost', 'postgres'].includes(new URL(url).hostname);
}

export function assertLocalDatabase(url: string): void {
	if (!isLocalDatabase(url) && process.env.ALLOW_DESTRUCTIVE_DB !== 'yes') {
		throw new Error(`Refusing to run a destructive script against non-local host ${new URL(url).hostname}`);
	}
}
