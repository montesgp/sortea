import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ClientPackRefusedError } from '../src/client-pack';
import { clientLoadUsage, clientPackPath, parseClientLoadArgs } from '../src/scripts/client-load-args';

const root = mkdtempSync(join(tmpdir(), 'client-load-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function refused(run: () => unknown): string {
	try {
		run();
	} catch (error) {
		expect(error).toBeInstanceOf(ClientPackRefusedError);
		return (error as Error).message;
	}
	throw new Error('expected a refusal');
}

describe('pnpm client:load arguments', () => {
	it('takes the client, --update and --host', () => {
		expect(parseClientLoadArgs(['acme'])).toEqual({ client: 'acme', update: false });
		expect(parseClientLoadArgs(['--update', 'acme', '--host', 'Tienda.Example.com'])).toEqual({ client: 'acme', update: true, host: 'tienda.example.com' });
	});

	it('takes --catalog only together with --update', () => {
		expect(parseClientLoadArgs(['acme', '--update', '--catalog'])).toEqual({ client: 'acme', update: true, catalog: true });
		expect(refused(() => parseClientLoadArgs(['acme', '--catalog']))).toBe(`--catalog updates the products of an existing organization; pass it with --update. ${clientLoadUsage}`);
		expect(clientLoadUsage).toBe('Usage: pnpm client:load <client> [--update [--catalog] [--campaign]] [--host <hostname>]');
	});

	it('takes --campaign only together with --update (launch prep 2026-11-10, S4)', () => {
		expect(parseClientLoadArgs(['acme', '--update', '--campaign'])).toEqual({ client: 'acme', update: true, campaign: true });
		expect(parseClientLoadArgs(['acme', '--update', '--catalog', '--campaign'])).toEqual({ client: 'acme', update: true, catalog: true, campaign: true });
		expect(refused(() => parseClientLoadArgs(['acme', '--campaign']))).toBe(`--campaign adds the pack's campaign to an existing organization; pass it with --update. ${clientLoadUsage}`);
	});

	it('refuses anything else with the usage', () => {
		expect(refused(() => parseClientLoadArgs([]))).toBe(clientLoadUsage);
		expect(refused(() => parseClientLoadArgs(['a', 'b']))).toBe(clientLoadUsage);
		expect(refused(() => parseClientLoadArgs(['acme', '--force']))).toBe(`Unexpected argument --force. ${clientLoadUsage}`);
		expect(refused(() => parseClientLoadArgs(['acme', '--host']))).toBe(`--host needs a hostname. ${clientLoadUsage}`);
		expect(refused(() => parseClientLoadArgs(['../acme']))).toBe('../acme is not a client name: use lowercase letters, digits and dashes.');
	});

	it('finds the pack under clients/, and says where packs live when it is missing', () => {
		mkdirSync(join(root, 'clients', 'acme'), { recursive: true });
		writeFileSync(join(root, 'clients', 'acme', 'pack.ts'), 'export const pack = {};\n');
		expect(clientPackPath(root, 'acme')).toBe(join(root, 'clients', 'acme', 'pack.ts'));
		expect(refused(() => clientPackPath(root, 'other'))).toBe('No client pack at clients/other/pack.ts. Client packs live only in the private repository, never in the public copy.');
	});
});
