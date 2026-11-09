#!/usr/bin/env node
// Builds the public copy of this repository (README, "Publishing the public copy").
//
//   pnpm publish:public [--target <branch>] [--remote <name>] [--dry-run]
//
// It takes the tree of HEAD without the paths in .public-exclude (client packs,
// working notes), refuses it when any file still mentions a client or carries a
// CUIT or CUIL number, and otherwise commits it as a single commit on top of the
// public remote's branch (default public/main). The commit goes to the local
// branch publish/<branch>; nothing is pushed, the push command is printed.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Lines of .public-exclude: `dir/` excludes everything under it, anything else one exact path. */
export function parseExcludes(text) {
	return text
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line && !line.startsWith('#'));
}

export function isExcluded(path, excludes) {
	return excludes.some((entry) => (entry.endsWith('/') ? path.startsWith(entry) : path === entry));
}

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Patterns for every client of `clients/<name>/`: its directory name, written with
 * or without spaces, dashes or underscores between its words, and the lines of its
 * `publish-forbidden.txt` (phone, handles, other spellings). The owner's own data
 * goes in `clients/publish-forbidden.txt`, with `name` empty.
 */
export function termsFromClients(clients) {
	const terms = [];
	for (const client of clients) {
		if (client.name) terms.push(new RegExp(client.name.split(/[-_\s]+/).map(escape).join('[\\s_-]?'), 'gi'));
		for (const term of client.forbidden) {
			const words = term.trim().split(/\s+/).filter(Boolean);
			if (words.length > 0) terms.push(new RegExp(words.map(escape).join('[\\s_-]?'), 'gi'));
		}
	}
	return terms;
}

/** CUIT and CUIL numbers whose check digit is valid. */
const cuitPattern = /\b(?:20|23|24|27|30|33|34)-?\d{8}-?\d\b/g;
/** The made-up CUIT that the identity tests use (packages/domain/test/payments-identity.test.ts). */
const allowedCuits = new Set(['20123456786']);

function validCuit(digits) {
	const weights = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
	const sum = weights.reduce((total, weight, index) => total + weight * Number(digits[index]), 0);
	const remainder = 11 - (sum % 11);
	return (remainder === 11 ? 0 : remainder === 10 ? 9 : remainder) === Number(digits[10]);
}

/**
 * Every mention of a client and every CUIT or CUIL number, as `{ path, line, match }`.
 * `text` is null for binary files, whose name is still checked (line 0).
 */
export function findClientMentions(files, terms) {
	const found = [];
	for (const { path, text } of files) {
		const named = terms.flatMap((term) => [...path.matchAll(term)]).sort((a, b) => a.index - b.index);
		if (named.length > 0) found.push({ path, line: 0, match: named[0][0] });
		if (text === null) continue;
		text.split(/\r?\n/).forEach((content, index) => {
			const matches = [];
			for (const term of terms) for (const match of content.matchAll(term)) matches.push(match);
			for (const match of content.matchAll(cuitPattern)) {
				const digits = match[0].replaceAll('-', '');
				if (validCuit(digits) && !allowedCuits.has(digits)) matches.push(match);
			}
			// One finding per place: a name can match both its own term and a spelling of it.
			matches.sort((a, b) => a.index - b.index || b[0].length - a[0].length);
			let end = -1;
			for (const match of matches) {
				if (match.index < end) continue;
				found.push({ path, line: index + 1, match: match[0] });
				end = match.index + match[0].length;
			}
		});
	}
	return found;
}

class PublishError extends Error {}

function git(cwd, args, options = {}) {
	const binary = options.encoding === 'buffer';
	const result = spawnSync('git', args, { cwd, ...(binary ? {} : { encoding: 'utf8' }), input: options.input, env: { ...process.env, ...options.env }, maxBuffer: 1024 * 1024 * 1024 });
	if (result.status !== 0 && !options.allowFailure) throw new PublishError(`git ${args.join(' ')} failed: ${String(result.stderr).trim()}`);
	return options.allowFailure ? result : binary ? result.stdout : result.stdout.trim();
}

/** Every blob of HEAD as `{ path, sha }`. */
function headFiles(root) {
	return git(root, ['ls-tree', '-r', '-z', '--full-tree', 'HEAD'])
		.split('\0')
		.filter(Boolean)
		.map((entry) => {
			const [meta, path] = entry.split('\t');
			const [, type, sha] = meta.split(' ');
			return { path, sha, type };
		})
		.filter((entry) => entry.type === 'blob');
}

/** Contents of many blobs with one `git cat-file --batch`; binary files (with a NUL byte) come back as null. */
function readBlobs(root, shas) {
	if (shas.length === 0) return new Map();
	const output = git(root, ['cat-file', '--batch'], { input: shas.join('\n') + '\n', encoding: 'buffer' });
	const blobs = new Map();
	let offset = 0;
	while (offset < output.length) {
		const end = output.indexOf(0x0a, offset);
		const [sha, , size] = output.subarray(offset, end).toString('utf8').split(' ');
		const content = output.subarray(end + 1, end + 1 + Number(size));
		blobs.set(sha, content.includes(0) ? null : content.toString('utf8'));
		offset = end + 1 + Number(size) + 1;
	}
	return blobs;
}

function parseArgs(argv) {
	const args = { target: 'main', remote: 'public', dryRun: false };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === '--dry-run') args.dryRun = true;
		else if (arg === '--target' || arg === '--remote') {
			const value = argv[++i];
			if (!value || value.startsWith('-')) throw new PublishError(`${arg} needs a value.`);
			args[arg.slice(2)] = value;
		} else throw new PublishError(`Unexpected argument ${arg}. Usage: pnpm publish:public [--target <branch>] [--remote <name>] [--dry-run]`);
	}
	return args;
}

function main(argv) {
	const args = parseArgs(argv);
	const root = git(process.cwd(), ['rev-parse', '--show-toplevel']);
	const short = git(root, ['rev-parse', '--short', 'HEAD']);
	if (git(root, ['status', '--porcelain'])) console.log('Note: the working tree has uncommitted changes; only the committed HEAD is published.');

	const files = headFiles(root);
	const byPath = new Map(files.map((file) => [file.path, file]));
	const read = (path) => (byPath.has(path) ? readBlobs(root, [byPath.get(path).sha]).get(byPath.get(path).sha) ?? '' : null);
	const excludeText = read('.public-exclude');
	if (excludeText === null) throw new PublishError('HEAD has no .public-exclude; it lists what never leaves the private repository.');
	const excludes = parseExcludes(excludeText);

	// Client names come from clients/<name>/, so this script never has to name a client.
	const clients = new Map();
	for (const { path } of files) {
		const match = /^clients\/([^/]+)\//.exec(path);
		if (match && !clients.has(match[1])) clients.set(match[1], { name: match[1], forbidden: parseExcludes(read(`clients/${match[1]}/publish-forbidden.txt`) ?? '') });
	}
	const ownerTerms = parseExcludes(read('clients/publish-forbidden.txt') ?? '');
	if (clients.size === 0) console.log('Note: HEAD has no clients/ directory, so only CUIT and CUIL numbers are checked.');
	const terms = termsFromClients([...clients.values(), { name: '', forbidden: ownerTerms }]);

	const published = files.filter((file) => !isExcluded(file.path, excludes));
	const blobs = readBlobs(root, [...new Set(published.map((file) => file.sha))]);
	console.log(`Snapshot of ${short}: ${published.length} files (${files.length - published.length} excluded)`);
	const mentions = findClientMentions(
		published.map((file) => ({ path: file.path, text: blobs.get(file.sha) ?? null })),
		terms
	);
	if (mentions.length > 0) {
		console.error(`The public copy would still mention a client or personal data (${mentions.length}):`);
		for (const mention of mentions) console.error(`  ${mention.path}:${mention.line}: ${mention.match}`);
		console.error('Move that content to clients/ or make it neutral, commit, and run again. Nothing was committed.');
		return 1;
	}
	console.log('No client mentions.');
	if (args.dryRun) {
		console.log('Dry run: nothing fetched or committed.');
		return 0;
	}

	const fetched = git(root, ['fetch', '--quiet', args.remote, args.target], { allowFailure: true });
	if (fetched.status !== 0) throw new PublishError(`Could not fetch ${args.target} from ${args.remote}: ${String(fetched.stderr).trim()}`);
	const parent = git(root, ['rev-parse', 'FETCH_HEAD']);

	// A temporary index builds the tree, so the working tree and the real index stay as they are.
	const scratch = mkdtempSync(join(tmpdir(), 'sortea-publish-'));
	try {
		const env = { GIT_INDEX_FILE: join(scratch, 'index'), GIT_LITERAL_PATHSPECS: '1' };
		git(root, ['read-tree', 'HEAD'], { env });
		const removed = files.filter((file) => isExcluded(file.path, excludes)).map((file) => file.path);
		if (removed.length > 0) git(root, ['rm', '--cached', '--quiet', '-r', '--pathspec-from-file=-', '--pathspec-file-nul'], { env, input: removed.join('\0') });
		const tree = git(root, ['write-tree'], { env });
		if (tree === git(root, ['rev-parse', `${parent}^{tree}`])) {
			console.log(`${args.remote}/${args.target} already has this content; nothing to publish.`);
			return 0;
		}
		const commit = git(root, ['commit-tree', tree, '-p', parent, '-m', `chore: publish ${short}`]);
		const branch = `publish/${args.target}`;
		git(root, ['update-ref', `refs/heads/${branch}`, commit]);
		console.log(`Committed ${commit.slice(0, 12)} on top of ${args.remote}/${args.target} (${parent.slice(0, 12)}) as the local branch ${branch}.`);
		console.log(`Review it, then push it with:\n  git push ${args.remote} ${branch}:${args.target}`);
		return 0;
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		process.exitCode = main(process.argv.slice(2));
	} catch (error) {
		console.error(error instanceof PublishError ? error.message : error);
		process.exitCode = 1;
	}
}
