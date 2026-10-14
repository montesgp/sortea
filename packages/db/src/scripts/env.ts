export function databaseUrl(): string {
	return process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
}

export function assertLocalDatabase(url: string): void {
	const host = new URL(url).hostname;
	if (!['127.0.0.1', 'localhost', 'postgres'].includes(host) && process.env.ALLOW_DESTRUCTIVE_DB !== 'yes') {
		throw new Error(`Refusing to run a destructive script against non-local host ${host}`);
	}
}
