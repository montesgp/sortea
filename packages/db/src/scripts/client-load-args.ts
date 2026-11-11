import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { ClientPackRefusedError } from '../client-pack';

export const clientLoadUsage = 'Usage: pnpm client:load <client> [--update [--catalog] [--campaign]] [--host <hostname>]';

export interface ClientLoadArgs {
	client: string;
	update: boolean;
	/** With `update`: also create missing products and update existing ones, files included. */
	catalog?: boolean;
	/** With `update`: also add the pack's campaign, as a draft, when the organization has none with its slug. */
	campaign?: boolean;
	/** Binds only this host instead of the pack's list, for a deployed environment's domain. */
	host?: string;
}

export function parseClientLoadArgs(argv: string[]): ClientLoadArgs {
	const positional: string[] = [];
	let update = false;
	let catalog = false;
	let campaign = false;
	let host: string | undefined;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]!;
		if (arg === '--update') update = true;
		else if (arg === '--catalog') catalog = true;
		else if (arg === '--campaign') campaign = true;
		else if (arg === '--host') {
			host = argv[++i];
			if (!host || host.startsWith('-')) throw new ClientPackRefusedError(`--host needs a hostname. ${clientLoadUsage}`);
		} else if (arg.startsWith('-')) throw new ClientPackRefusedError(`Unexpected argument ${arg}. ${clientLoadUsage}`);
		else positional.push(arg);
	}
	const [client] = positional;
	if (!client || positional.length > 1) throw new ClientPackRefusedError(clientLoadUsage);
	if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(client)) throw new ClientPackRefusedError(`${client} is not a client name: use lowercase letters, digits and dashes.`);
	if (catalog && !update) throw new ClientPackRefusedError(`--catalog updates the products of an existing organization; pass it with --update. ${clientLoadUsage}`);
	if (campaign && !update) throw new ClientPackRefusedError(`--campaign adds the pack's campaign to an existing organization; pass it with --update. ${clientLoadUsage}`);
	return { client, update, ...(catalog ? { catalog } : {}), ...(campaign ? { campaign } : {}), ...(host ? { host: host.toLowerCase() } : {}) };
}

/** `clients/<client>/files`: the pack's real product files, kept outside git (packages/db/src/client-files.ts). */
export function clientFilesDir(repositoryRoot: string, client: string): string {
	return resolve(repositoryRoot, 'clients', client, 'files');
}

/** `clients/<client>/pack.ts` under the repository root; the directory exists only in the private repository. */
export function clientPackPath(repositoryRoot: string, client: string): string {
	const path = resolve(repositoryRoot, 'clients', client, 'pack.ts');
	if (!existsSync(path)) {
		throw new ClientPackRefusedError(`No client pack at clients/${client}/pack.ts. Client packs live only in the private repository, never in the public copy.`);
	}
	return path;
}
