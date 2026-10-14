import { prepareTestDatabase } from '../src/testing';

export default async function setup({ provide }: { provide: (key: 'databaseUrl', value: string) => void }) {
	provide('databaseUrl', await prepareTestDatabase('sortea_test_db'));
}

declare module 'vitest' {
	export interface ProvidedContext {
		databaseUrl: string;
	}
}
