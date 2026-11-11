// Run with: node --test scripts (part of `pnpm test`).
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { findClientMentions, isExcluded, parseExcludes, termsFromClients } from './publish-public.mjs';

const script = join(dirname(fileURLToPath(import.meta.url)), 'publish-public.mjs');
// Built at run time, so this file never carries a client's name itself.
const brand = ['Acme', 'Motors'].join('');

describe('findClientMentions', () => {
	const terms = termsFromClients([{ name: brand.toLowerCase(), forbidden: ['acme motors', '5491100000000'] }]);

	it('lists every case-insensitive mention of a client with its file and line', () => {
		const files = [
			{ path: 'README.md', text: `# Title\nBuilt for ${brand}.\nnothing here\nVisit ${brand.toUpperCase()} or Acme Motors or acme_motors.` },
			{ path: 'apps/web/e2e/social.e2e.ts', text: `const link = 'https://tiktok.com/@taller${brand.toLowerCase()}';` },
			{ path: 'src/clean.ts', text: 'export const x = 1;' }
		];
		assert.deepEqual(findClientMentions(files, terms), [
			{ path: 'README.md', line: 2, match: brand },
			{ path: 'README.md', line: 4, match: brand.toUpperCase() },
			{ path: 'README.md', line: 4, match: 'Acme Motors' },
			{ path: 'README.md', line: 4, match: 'acme_motors' },
			{ path: 'apps/web/e2e/social.e2e.ts', line: 1, match: brand.toLowerCase() }
		]);
	});

	it('finds the private terms of a client, such as its phone', () => {
		assert.deepEqual(findClientMentions([{ path: 'a.ts', text: "whatsapp: '5491100000000'" }], terms), [{ path: 'a.ts', line: 1, match: '5491100000000' }]);
	});

	it('finds a client in a file name, even when the file is binary', () => {
		assert.deepEqual(findClientMentions([{ path: `static/${brand.toLowerCase()}/logo.png`, text: null }], terms), [
			{ path: `static/${brand.toLowerCase()}/logo.png`, line: 0, match: brand.toLowerCase() }
		]);
	});

	it('finds CUIT and CUIL numbers with a valid check digit, except the documented test number', () => {
		// Joined at run time, so this file never carries a valid number itself.
		const cuit = ['20-30123456', '3'].join('-');
		const cuil = ['2730123456', '8'].join('');
		const files = [{ path: 'a.md', text: [`CUIT ${cuit}`, `CUIL ${cuil}`, 'wrong digit 20-30123456-7', 'the tests use 20-12345678-6', 'a phone 5491123456789'].join('\n') }];
		assert.deepEqual(findClientMentions(files, []), [
			{ path: 'a.md', line: 1, match: cuit },
			{ path: 'a.md', line: 2, match: cuil }
		]);
	});

	it('finds nothing in neutral content', () => {
		assert.deepEqual(findClientMentions([{ path: 'a.ts', text: "name: 'Taller Demo', order: 'MOTOG-7K2Q9XHD'" }], terms), []);
	});
});

describe('.public-exclude', () => {
	it('excludes directories by prefix and files by exact path, ignoring comments', () => {
		const excludes = parseExcludes('# private\nclients/\nodd/\n\n.cache/\nnotes.md\n');
		assert.deepEqual(excludes, ['clients/', 'odd/', '.cache/', 'notes.md']);
		assert.equal(isExcluded('clients/acme/pack.ts', excludes), true);
		assert.equal(isExcluded('odd/tasks/x.md', excludes), true);
		assert.equal(isExcluded('notes.md', excludes), true);
		assert.equal(isExcluded('docs/notes.md', excludes), false);
		assert.equal(isExcluded('oddity.md', excludes), false);
	});

	it('lets a * stand for one path segment', () => {
		const excludes = parseExcludes('clients/*/files/\n');
		assert.equal(isExcluded('clients/acme/files/0123456789abcdef-manual.pdf', excludes), true);
		assert.equal(isExcluded('clients/acme/pack.ts', excludes), false);
		assert.equal(isExcluded('clients/a/b/files/x.pdf', excludes), false);
		assert.equal(isExcluded('clients/*/files/x.pdf', parseExcludes('clients/acme/files/\n')), false);
	});
});

describe('pnpm publish:public against temporary repositories', () => {
	const root = mkdtempSync(join(tmpdir(), 'sortea-publish-'));
	after(() => rmSync(root, { recursive: true, force: true }));
	const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
	const write = (base, path, text) => {
		mkdirSync(dirname(join(base, path)), { recursive: true });
		writeFileSync(join(base, path), text);
	};
	const identity = ['-c', 'user.name=Test', '-c', 'user.email=test@example.com'];

	// The public repository, with history of its own.
	const publicRepo = join(root, 'public.git');
	const seed = join(root, 'seed');
	git(root, 'init', '-q', '--bare', publicRepo);
	git(root, 'init', '-q', '-b', 'main', seed);
	write(seed, 'README.md', '# Old public copy\n');
	git(seed, 'add', '.');
	git(seed, ...identity, 'commit', '-q', '-m', 'public history');
	git(seed, 'push', '-q', publicRepo, 'main');
	const publicMain = git(seed, 'rev-parse', 'HEAD');

	// The private repository, with a client and working notes.
	const privateRepo = join(root, 'private');
	git(root, 'init', '-q', '-b', 'main', privateRepo);
	git(privateRepo, 'remote', 'add', 'public', publicRepo);
	write(privateRepo, '.public-exclude', 'clients/\nodd/\n');
	write(privateRepo, 'README.md', '# Sortea\nA platform.\n');
	write(privateRepo, 'apps/web/static/tenants/taller-demo/logo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 1]));
	write(privateRepo, `clients/${brand.toLowerCase()}/pack.ts`, `export const pack = { name: '${brand}' };\n`);
	write(privateRepo, `clients/${brand.toLowerCase()}/publish-forbidden.txt`, '# Client data that must never be published\nacme motors\n');
	write(privateRepo, 'odd/tasks/notes.md', `Talked with ${brand}.\n`);
	git(privateRepo, 'add', '.');
	git(privateRepo, ...identity, 'commit', '-q', '-m', 'private work');
	const privateShort = git(privateRepo, 'rev-parse', '--short', 'HEAD');

	const run = (...args) => spawnSync(process.execPath, [script, ...args], { cwd: privateRepo, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com' } });

	it('checks the snapshot in dry mode without fetching or committing', () => {
		const result = run('--dry-run');
		assert.equal(result.status, 0, result.stderr);
		assert.match(result.stdout, /Snapshot of [0-9a-f]+: 3 files \(3 excluded\)/);
		assert.match(result.stdout, /No client mentions\./);
		assert.match(result.stdout, /Dry run: nothing fetched or committed\./);
		assert.equal(spawnSync('git', ['rev-parse', '--verify', '-q', 'refs/heads/publish/main'], { cwd: privateRepo }).status, 1);
	});

	it('commits the snapshot on top of the public branch and prints the push command, without pushing', () => {
		const result = run('--target', 'main');
		assert.equal(result.status, 0, result.stderr);
		const commit = git(privateRepo, 'rev-parse', 'refs/heads/publish/main');
		assert.equal(git(privateRepo, 'rev-parse', `${commit}^`), publicMain);
		assert.equal(git(privateRepo, 'log', '-1', '--format=%s', commit), `chore: publish ${privateShort}`);
		assert.deepEqual(git(privateRepo, 'ls-tree', '-r', '--name-only', commit).split('\n'), ['.public-exclude', 'README.md', 'apps/web/static/tenants/taller-demo/logo.png']);
		assert.match(result.stdout, /git push public publish\/main:main/);
		// Nothing was pushed: the public repository still ends at its own history.
		assert.equal(git(publicRepo, 'rev-parse', 'main'), publicMain);
	});

	it('refuses a snapshot that mentions a client, listing file and line, and commits nothing', () => {
		write(privateRepo, 'docs/guide.md', `# Guide\n\nFirst client: ${brand}.\n`);
		git(privateRepo, 'add', '.');
		git(privateRepo, ...identity, 'commit', '-q', '-m', 'leak');
		const before = git(privateRepo, 'rev-parse', 'refs/heads/publish/main');

		const result = run('--target', 'main');

		assert.equal(result.status, 1);
		assert.match(result.stderr, new RegExp(`docs/guide\\.md:3: ${brand}`));
		assert.match(result.stderr, /Nothing was committed/);
		assert.equal(git(privateRepo, 'rev-parse', 'refs/heads/publish/main'), before);
	});

	it('refuses a target branch the public remote does not have', () => {
		git(privateRepo, 'rm', '-q', 'docs/guide.md');
		git(privateRepo, ...identity, 'commit', '-q', '-m', 'fix leak');
		const result = run('--target', 'missing');
		assert.equal(result.status, 1);
		assert.match(result.stderr, /Could not fetch missing from public/);
	});
});
