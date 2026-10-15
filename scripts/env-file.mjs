// Reading and rewriting the repository's .env with the same rules as Node's
// --env-file, which is how the API, worker and web load it.
import { existsSync, readFileSync } from 'node:fs';

const linePattern = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/;

/**
 * Node's value rules: a quoted value is what is between the quotes (a `#`
 * inside is kept, anything after the closing quote is ignored); an unquoted
 * value ends at the first `#` and is trimmed.
 */
export function parseEnvValue(raw) {
	const text = raw.trim();
	const quote = text[0];
	if (quote === '"' || quote === "'" || quote === '`') {
		const end = text.indexOf(quote, 1);
		if (end > 0) return text.slice(1, end);
	}
	const hash = text.indexOf('#');
	return (hash >= 0 ? text.slice(0, hash) : text).trim();
}

/** Values and the raw text after `=` of every setting, in file order. */
export function parseEnv(text) {
	const values = {};
	const raw = {};
	for (const line of text.split(/\r?\n/)) {
		const match = linePattern.exec(line);
		if (!match) continue;
		values[match[1]] = parseEnvValue(match[2]);
		raw[match[1]] = match[2].trim();
	}
	return { values, raw };
}

/** Parsed .env, or null when the file does not exist. */
export function readEnv(path) {
	return existsSync(path) ? parseEnv(readFileSync(path, 'utf8')) : null;
}

/** Values of the .env, or null when the file does not exist. */
export function readEnvFile(path) {
	return readEnv(path)?.values ?? null;
}

/**
 * The effective value a process started with --env-file sees: a variable
 * already set in the environment wins over the file.
 */
export function effectiveEnvValue(key, fileValues, environment = process.env) {
	const fromEnvironment = environment[key];
	return fromEnvironment !== undefined && fromEnvironment !== '' ? fromEnvironment : (fileValues?.[key] ?? '');
}

/**
 * Builds the new .env text from env.template. Supabase settings always come
 * from the running local Supabase; every other value already in the file is
 * kept exactly as written (quotes included); missing secrets are generated;
 * settings that are not in the template are appended. Pure, for tests.
 */
export function buildEnvFile({ template, existing, fromSupabase, generators }) {
	const generated = [];
	const kept = [];
	const templateKeys = new Set();
	const current = existing ?? { values: {}, raw: {} };

	let output = template.replace(/^([A-Za-z_][A-Za-z0-9_]*)=.*$/gm, (line, key) => {
		templateKeys.add(key);
		if (fromSupabase[key]) return `${key}=${fromSupabase[key]}`;
		if (current.values[key]) {
			kept.push(key);
			return `${key}=${current.raw[key]}`;
		}
		if (generators[key]) {
			generated.push(key);
			return `${key}=${generators[key]()}`;
		}
		return line;
	});

	const extra = Object.keys(current.raw).filter((key) => !templateKeys.has(key) && current.values[key]);
	if (extra.length > 0) {
		output += `\n# ─── Kept from the previous .env ─────────────────────────────────────────\n${extra.map((key) => `${key}=${current.raw[key]}`).join('\n')}\n`;
		kept.push(...extra);
	}
	return { text: output, generated, kept };
}
