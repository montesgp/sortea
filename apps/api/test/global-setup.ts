import { prepareTestDatabase } from '@sortea/db/testing';

export default async function setup({ provide }: { provide: (key: 'databaseUrl', value: string) => void }) {
	provide('databaseUrl', await prepareTestDatabase('sortea_test_api'));
}

declare module 'vitest' {
	export interface ProvidedContext {
		databaseUrl: string;
	}
}
