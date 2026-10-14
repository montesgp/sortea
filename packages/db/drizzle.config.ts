import { defineConfig } from 'drizzle-kit';

export default defineConfig({
	dialect: 'postgresql',
	schema: './src/schema.ts',
	out: './migrations',
	schemaFilter: ['app'],
	dbCredentials: {
		url: process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'
	},
	migrations: { schema: 'app', table: '__migrations' },
	strict: true,
	verbose: true
});
