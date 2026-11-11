import { describe, expect, it } from 'vitest';
import {
	backupKey,
	backupScheduleFromEnv,
	BackupRefusedError,
	describeDatabase,
	expiredBackups,
	listedBackups,
	nightlyBackupDue,
	parseBackupKey,
	parseRestoreArgs,
	pgEnvironment,
	restoreRefusal,
	sameServerDatabase,
	confirmationFor,
	type BackupEntry,
	type BackupReason
} from '../src/backups';
import { restoreContext } from '../src/backup-runner';

const DAY = 86_400_000;

function entry(at: Date, reason: BackupReason, environment = 'production'): BackupEntry {
	return { key: backupKey(environment, at, reason), environment, at, reason, complete: true };
}

/** One nightly dump per day at 06:00 UTC for `days` days ending on `last`. */
function nights(last: Date, days: number): BackupEntry[] {
	return Array.from({ length: days }, (_, i) => entry(new Date(last.getTime() - i * DAY), 'nightly'));
}

describe('backup keys', () => {
	it('names a dump by environment, UTC time and reason', () => {
		expect(backupKey('production', new Date('2026-11-10T06:00:07.123Z'), 'nightly')).toBe('backups/production/20261110T060007Z-nightly.dump');
		expect(backupKey('staging', new Date('2026-01-02T23:59:59Z'), 'pre-migrate')).toBe('backups/staging/20260102T235959Z-pre-migrate.dump');
	});

	it('reads its own keys back and ignores anything else under the prefix', () => {
		const key = 'backups/production/20261110T060007Z-pre-migrate.dump';
		expect(parseBackupKey(key)).toEqual({ key, environment: 'production', at: new Date('2026-11-10T06:00:07Z'), reason: 'pre-migrate' });
		for (const other of [
			`${key}.sha256`,
			'backups/production/20261110T060007Z-weekly.dump',
			'backups/production/20261310T060007Z-nightly.dump',
			'backups/production/nested/20261110T060007Z-nightly.dump',
			'backups/Production/20261110T060007Z-nightly.dump',
			'site-media/20261110T060007Z-nightly.dump',
			'backups/production/notes.txt'
		]) {
			expect(parseBackupKey(other), other).toBeNull();
		}
	});

	it('refuses an environment that is not a plain name', () => {
		expect(() => backupKey('../prod', new Date(), 'manual')).toThrow(BackupRefusedError);
		expect(() => backupKey('Prod', new Date(), 'manual')).toThrow(BackupRefusedError);
	});

	it('lists one environment, newest first', () => {
		const old = backupKey('production', new Date('2026-11-01T06:00:00Z'), 'nightly');
		const recent = backupKey('production', new Date('2026-11-09T06:00:00Z'), 'manual');
		const staging = backupKey('staging', new Date('2026-11-10T06:00:00Z'), 'nightly');
		expect(listedBackups([old, `${old}.sha256`, staging, recent], 'production').map((e) => e.key)).toEqual([recent, old]);
	});
});

describe('retention', () => {
	// A Tuesday: 2026-11-10.
	const now = new Date('2026-11-10T07:00:00Z');

	it('keeps the newest 14 nightly and the newest 8 Sunday dumps, and deletes the rest with their sidecars', () => {
		const all = nights(new Date('2026-11-10T06:00:00Z'), 120);
		const expired = new Set(expiredBackups(all, now));
		const kept = all.filter((e) => !expired.has(e.key));

		const newest14 = all.slice(0, 14);
		const sundays = all.filter((e) => e.at.getUTCDay() === 0);
		expect(sundays.slice(0, 8).every((e) => e.at.getUTCDay() === 0)).toBe(true);
		const expected = new Set([...newest14, ...sundays.slice(0, 8)].map((e) => e.key));
		expect(new Set(kept.map((e) => e.key))).toEqual(expected);
		// Two of the 8 Sundays fall inside the newest 14 nights.
		expect(kept).toHaveLength(14 + 8 - 2);
		for (const e of all.filter((x) => !expected.has(x.key))) {
			expect(expired.has(e.key)).toBe(true);
			expect(expired.has(`${e.key}.sha256`)).toBe(true);
		}
	});

	it('keeps pre-migration and manual dumps for 30 days whatever the nightly count', () => {
		const inside = entry(new Date(now.getTime() - 30 * DAY), 'pre-migrate');
		const outside = entry(new Date(now.getTime() - 30 * DAY - 1000), 'pre-migrate');
		const manual = entry(new Date(now.getTime() - 29 * DAY), 'manual');
		const oldManual = entry(new Date(now.getTime() - 31 * DAY), 'manual');
		const expired = expiredBackups([...nights(new Date('2026-11-10T06:00:00Z'), 14), inside, outside, manual, oldManual], now);
		expect(expired).toEqual([outside.key, `${outside.key}.sha256`, oldManual.key, `${oldManual.key}.sha256`]);
	});

	it('never deletes the newest dump, even an old one', () => {
		const lone = entry(new Date('2025-01-01T00:00:00Z'), 'manual');
		expect(expiredBackups([lone], now)).toEqual([]);
	});

	it('deletes nothing while there are fewer dumps than the limits', () => {
		expect(expiredBackups(nights(new Date('2026-11-10T06:00:00Z'), 10), now)).toEqual([]);
		expect(expiredBackups([], now)).toEqual([]);
	});
});

describe('nightly schedule', () => {
	it('is due once the hour has passed and no nightly dump exists since', () => {
		expect(nightlyBackupDue(new Date('2026-11-10T06:00:00Z'), 6, null)).toBe(true);
		expect(nightlyBackupDue(new Date('2026-11-10T06:00:00Z'), 6, new Date('2026-11-09T06:00:05Z'))).toBe(true);
		expect(nightlyBackupDue(new Date('2026-11-10T06:30:00Z'), 6, new Date('2026-11-10T06:00:05Z'))).toBe(false);
	});

	it('before the hour, last night counts, so a restart in the morning does not dump again', () => {
		expect(nightlyBackupDue(new Date('2026-11-10T05:59:59Z'), 6, new Date('2026-11-09T06:00:05Z'))).toBe(false);
		expect(nightlyBackupDue(new Date('2026-11-10T05:59:59Z'), 6, new Date('2026-11-09T05:59:00Z'))).toBe(true);
	});

	it('a worker that was down at the hour catches up once', () => {
		const late = new Date('2026-11-10T21:00:00Z');
		expect(nightlyBackupDue(late, 6, new Date('2026-11-08T06:00:00Z'))).toBe(true);
		expect(nightlyBackupDue(new Date('2026-11-10T21:15:00Z'), 6, late)).toBe(false);
	});

	it('reads its variables: off unless BACKUP_ENABLED=true, hour 6 by default, named environment', () => {
		expect(backupScheduleFromEnv({})).toEqual({ enabled: false, hourUtc: 6, environment: 'development' });
		expect(backupScheduleFromEnv({ BACKUP_ENABLED: 'true', BACKUP_HOUR_UTC: '0', DEPLOY_ENVIRONMENT: 'production' })).toEqual({ enabled: true, hourUtc: 0, environment: 'production' });
		for (const hour of ['24', '-1', '6.5', 'six', '']) expect(() => backupScheduleFromEnv({ BACKUP_HOUR_UTC: hour }), hour).toThrow(BackupRefusedError);
		expect(() => backupScheduleFromEnv({ DEPLOY_ENVIRONMENT: 'prod/../x' })).toThrow(BackupRefusedError);
	});
});

describe('connection details', () => {
	it('passes the credentials to the tools as libpq variables', () => {
		expect(pgEnvironment('postgresql://user%40x:p%40ss@db.internal:6543/app_db?sslmode=require')).toEqual({
			PGHOST: 'db.internal',
			PGPORT: '6543',
			PGDATABASE: 'app_db',
			PGUSER: 'user@x',
			PGPASSWORD: 'p@ss',
			PGSSLMODE: 'require'
		});
		expect(pgEnvironment('postgres://u:p@[::1]/d').PGHOST).toBe('::1');
	});

	it('describes a database without its credentials', () => {
		expect(describeDatabase('postgresql://user:secret@db.internal/app')).toBe('db.internal:5432/app');
	});
});

describe('restore guards', () => {
	const key = 'backups/production/20261110T060000Z-nightly.dump';
	const productionUrl = 'postgresql://postgres:a@postgres.railway.internal:5432/railway';
	const prodServer = { database: 'railway', systemIdentifier: '7406112233445566778' };
	const stagingServer = { database: 'railway', systemIdentifier: '7406998877665544332' };

	it('parses the command line', () => {
		expect(parseRestoreArgs([key, '--target', 'postgresql://u:p@h/scratch', '--confirm', 'scratch'])).toEqual({ key, target: 'postgresql://u:p@h/scratch', confirm: 'scratch', production: false });
		expect(parseRestoreArgs([key, '--target', 'postgresql://u:p@h/d', '--i-know-this-is-production']).production).toBe(true);
		expect(() => parseRestoreArgs([key])).toThrow(/Usage/);
		expect(() => parseRestoreArgs([key, '--target'])).toThrow(/--target needs a value/);
		expect(() => parseRestoreArgs([key, key, '--target', 'postgresql://h/d'])).toThrow(/Usage/);
		expect(() => parseRestoreArgs([key, '--target', 'postgresql://h/d', '--force'])).toThrow(/Unexpected argument --force/);
	});

	it('never echoes a connection string in argument errors', () => {
		for (const argv of [
			['k', '--target=postgresql://u:hunter2@h/x'],
			['postgresql://u:hunter2@h/x', '--target', 'postgresql://u:p@h/x'],
			['k', '--target', 'postgresql://u:p@h/x', 'postgresql://u:hunter2@h/y']
		]) {
			let message = '';
			try {
				const a = parseRestoreArgs(argv);
				message = restoreRefusal(a, {}) ?? '';
			} catch (e) {
				message = (e as Error).message;
			}
			expect(message, argv.join(' ')).not.toContain('hunter2');
			expect(message).not.toBe('');
		}
		expect(() => parseRestoreArgs(['k', '--target=postgresql://u:hunter2@h/x'])).toThrow(/Unexpected argument --target=…/);
	});

	it('without the target identity, asks for the database name typed back', () => {
		const args = parseRestoreArgs([key, '--target', 'postgresql://u:p@localhost:5432/scratch']);
		expect(restoreRefusal(args, {})).toBe('Restoring replaces the app schema of localhost:5432/scratch. Pass --confirm scratch to confirm the target.');
		expect(restoreRefusal({ ...args, confirm: 'other' }, {})).toMatch(/--confirm scratch/);
		expect(restoreRefusal({ ...args, confirm: 'scratch' }, {})).toBeNull();
	});

	it('with the target identity, asks for the database name and the server: staging and production are both "railway"', () => {
		const args = parseRestoreArgs([key, '--target', productionUrl, '--confirm', 'railway']);
		expect(confirmationFor(prodServer)).toBe('railway@566778');
		expect(confirmationFor(stagingServer)).toBe('railway@544332');
		expect(confirmationFor({ database: 'scratch', systemIdentifier: null })).toBe('scratch');
		expect(restoreRefusal(args, { target: prodServer })).toBe(
			'Restoring replaces the app schema of postgres.railway.internal:5432/railway (server …566778). Pass --confirm railway@566778 to confirm the target.'
		);
		expect(restoreRefusal({ ...args, confirm: 'railway@544332' }, { target: prodServer })).toMatch(/--confirm railway@566778/);
		expect(restoreRefusal({ ...args, confirm: 'railway@566778' }, { target: prodServer })).toBeNull();
	});

	it('refuses keys that are not dumps and targets that are not Postgres', () => {
		expect(restoreRefusal({ key: 'site-media/x.dump', target: 'postgresql://h/d', confirm: 'd', production: false }, {})).toMatch(/is not a backup key/);
		expect(restoreRefusal({ key, target: 'mysql://h/d', confirm: 'd', production: false }, {})).toMatch(/postgres:\/\//);
		expect(restoreRefusal({ key, target: 'postgresql://h', confirm: '', production: false }, {})).toMatch(/names no database/);
	});

	it('compares servers by system identifier and database', () => {
		expect(sameServerDatabase(prodServer, { ...prodServer })).toBe(true);
		expect(sameServerDatabase(prodServer, stagingServer)).toBe(false);
		expect(sameServerDatabase(prodServer, { ...prodServer, database: 'rehearsal' })).toBe(false);
		expect(sameServerDatabase(prodServer, { ...prodServer, systemIdentifier: null })).toBeNull();
	});

	it('refuses the production database under any spelling of its host, unless told it is production', () => {
		// Same server and database as DATABASE_URL, written with its IP and with a trailing dot.
		for (const target of ['postgresql://u:p@10.250.3.7:5432/railway', 'postgresql://u:p@postgres.railway.internal.:5432/railway']) {
			const args = { key, target, confirm: 'railway@566778', production: false };
			const context = { target: prodServer, production: { url: productionUrl, identity: prodServer } };
			expect(restoreRefusal(args, context), target).toMatch(/production environment's own database.*--i-know-this-is-production/);
			expect(restoreRefusal({ ...args, production: true }, context)).toBeNull();
		}
		// Another server with a database of the same name is not production.
		expect(restoreRefusal({ key, target: productionUrl, confirm: 'railway@544332', production: false }, { target: stagingServer, production: { url: productionUrl, identity: prodServer } })).toBeNull();
	});

	// Independent re-verification of b841dbc: comparing connection strings let an IP or another host spelling through.
	it('in production, refuses whenever an identity is unknown, unless told it is production', () => {
		const own = { key, target: 'postgresql://other:creds@postgres.railway.internal:5432/railway?sslmode=disable', confirm: 'railway', production: false };
		for (const unknown of [
			{ target: { database: 'railway', systemIdentifier: null }, production: { url: productionUrl, identity: null } },
			{ target: { database: 'railway', systemIdentifier: null }, production: { url: null, identity: null } },
			{ target: { database: 'railway', systemIdentifier: null }, production: { url: productionUrl, identity: prodServer } }
		]) {
			for (const target of [own.target, 'postgresql://u:p@10.250.3.7:5432/railway', 'postgresql://u:p@other.internal:5432/railway']) {
				expect(restoreRefusal({ ...own, target }, unknown), target).toMatch(/system identifiers.*--i-know-this-is-production/);
				expect(restoreRefusal({ ...own, target, production: true }, unknown)).toBeNull();
			}
		}
	});

	it('in production, refuses when DATABASE_URL could not be identified, unless the flag is given', () => {
		const context = { target: { database: 'railway', systemIdentifier: '7000000000000123456' }, production: { url: 'postgresql://u:p@db.internal:5432/railway', identity: null } };
		const args = { key: 'backups/production/20261110T060000Z-nightly.dump', target: 'postgresql://u:p@10.0.0.5:5432/railway', confirm: 'railway@123456', production: false };
		expect(restoreRefusal(args, context)).toMatch(/production/);
		expect(restoreRefusal({ ...args, production: true }, context)).toBeNull();
	});
});

describe('restore context', () => {
	const key = 'backups/production/20261110T060000Z-nightly.dump';
	const target = 'postgresql://u:p@localhost:5432/scratch';
	const args = { key, target, confirm: 'scratch', production: false };
	const server = (database: string) => ({ database, systemIdentifier: '7406112233445566778' });

	it('asks only the target outside production', async () => {
		const asked: string[] = [];
		const result = await restoreContext(args, { DEPLOY_ENVIRONMENT: 'staging', DATABASE_URL: 'postgresql://u:p@db/railway' }, async (url) => {
			asked.push(url);
			return server('scratch');
		});
		expect(asked).toEqual([target]);
		expect(result).toEqual({ context: { target: server('scratch') }, notes: [] });
	});

	it("in production, asks DATABASE_URL's server too", async () => {
		const result = await restoreContext(args, { DEPLOY_ENVIRONMENT: 'production', DATABASE_URL: 'postgresql://u:p@db/railway' }, async (url) => server(url.endsWith('railway') ? 'railway' : 'scratch'));
		expect(result.context.production).toEqual({ url: 'postgresql://u:p@db/railway', identity: server('railway') });
		expect(result.notes).toEqual([]);
	});

	it('says so when production cannot be recognised, without printing connection strings', async () => {
		const unreachable = await restoreContext(args, { DEPLOY_ENVIRONMENT: 'production', DATABASE_URL: 'postgresql://u:hunter2@db/railway' }, async (url) => {
			if (url.includes('hunter2')) throw new Error('connect ECONNREFUSED');
			return { database: 'scratch', systemIdentifier: null };
		});
		expect(unreachable.context.production).toEqual({ url: 'postgresql://u:hunter2@db/railway', identity: null });
		const notes = unreachable.notes.join(' ');
		expect(notes).toMatch(/DATABASE_URL did not answer.*--i-know-this-is-production/);
		expect(notes).toMatch(/system identifier of the target/);
		expect(notes).not.toContain('hunter2');

		const unset = await restoreContext(args, { DEPLOY_ENVIRONMENT: 'production' }, async () => server('scratch'));
		expect(unset.context.production).toEqual({ url: null, identity: null });
		expect(unset.notes.join(' ')).toMatch(/DATABASE_URL is not set.*--i-know-this-is-production/);
	});
});

describe('BACKUP_ENABLED', () => {
	it('refuses a BACKUP_ENABLED it does not understand', () => {
		for (const v of ['TRUE', '1', 'yes']) expect(() => backupScheduleFromEnv({ BACKUP_ENABLED: v }), v).toThrow(BackupRefusedError);
		expect(backupScheduleFromEnv({}).enabled).toBe(false);
		expect(backupScheduleFromEnv({ BACKUP_ENABLED: '' }).enabled).toBe(false);
		expect(backupScheduleFromEnv({ BACKUP_ENABLED: 'false' }).enabled).toBe(false);
		expect(backupScheduleFromEnv({ BACKUP_ENABLED: 'true' }).enabled).toBe(true);
	});
});

describe('dumps without their checksum', () => {
	const now = new Date('2026-11-10T07:00:00Z');
	const dump = (at: string) => backupKey('production', new Date(at), 'nightly');

	it('are listed as incomplete', () => {
		const done = dump('2026-11-09T06:00:00Z');
		const cut = dump('2026-11-10T06:00:00Z');
		expect(listedBackups([done, `${done}.sha256`, cut], 'production').map((e) => [e.key, e.complete])).toEqual([
			[cut, false],
			[done, true]
		]);
	});

	it('do not count toward the retention and are deleted once an hour old', () => {
		const complete = nights(new Date('2026-11-09T06:00:00Z'), 14);
		const fresh = { ...entry(new Date('2026-11-10T06:30:00Z'), 'nightly'), complete: false };
		const stale = { ...entry(new Date('2026-11-10T05:00:00Z'), 'nightly'), complete: false };
		expect(expiredBackups([...complete, fresh, stale], now)).toEqual([stale.key, `${stale.key}.sha256`]);
	});
});
