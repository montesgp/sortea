// Minimal reader for the repository's .env (KEY=VALUE lines, optional quotes).
import { existsSync, readFileSync } from 'node:fs';

/** Returns the settings in order, or null when the file does not exist. */
export function readEnvFile(path) {
	if (!existsSync(path)) return null;
	const values = {};
	for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
		const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
		if (match) values[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2').trim();
	}
	return values;
}
