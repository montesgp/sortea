import { backupKey, checksumKey } from '@sortea/db/backups';
import { describe, expect, it } from 'vitest';
import { createNightlyBackup } from '../src/nightly-backup';

/** A bucket listing that grows with every dump the fake takes, as the real one does. */
function fakeBucket(initial: string[] = []) {
	const keys = [...initial];
	const taken: { at: Date; reason: string }[] = [];
	return {
		keys,
		taken,
		list: async () => [...keys],
		take: async (at: Date) => {
			taken.push({ at, reason: 'nightly' });
			keys.push(backupKey('production', at, 'nightly'), checksumKey(backupKey('production', at, 'nightly')));
			return { key: backupKey('production', at, 'nightly'), bytes: 10, sha256: 'x' };
		},
		prune: async () => [] as string[]
	};
}

const schedule = { enabled: true, hourUtc: 6, environment: 'production' };

describe('nightly backup in the worker', () => {
	it('is off unless enabled', () => {
		const bucket = fakeBucket();
		expect(createNightlyBackup({ ...bucket, schedule: { ...schedule, enabled: false } })).toBeNull();
	});

	it('dumps once per night: a check after the dump, or after a restart, finds it in the bucket', async () => {
		const last = backupKey('production', new Date('2026-11-09T06:00:10Z'), 'nightly');
		const bucket = fakeBucket([last, checksumKey(last)]);
		const tick = createNightlyBackup({ ...bucket, schedule })!;

		expect(await tick(new Date('2026-11-10T05:59:00Z'))).toBe('not due');
		expect(await tick(new Date('2026-11-10T06:00:30Z'))).toMatch(/^backup backups\/production\/20261110T060030Z-nightly\.dump/);
		expect(await tick(new Date('2026-11-10T06:30:00Z'))).toBe('not due');

		const restarted = createNightlyBackup({ ...bucket, schedule })!;
		expect(await restarted(new Date('2026-11-10T07:00:00Z'))).toBe('not due');
		expect(bucket.taken).toHaveLength(1);
	});

	it('a dump without its checksum does not count, so the next check takes it again', async () => {
		// The worker stopped between the upload and the checksum: restore would refuse that dump.
		const bucket = fakeBucket([backupKey('production', new Date('2026-11-10T06:00:10Z'), 'nightly')]);
		const tick = createNightlyBackup({ ...bucket, schedule })!;
		expect(await tick(new Date('2026-11-10T06:20:00Z'))).toMatch(/^backup /);
		expect(await tick(new Date('2026-11-10T06:30:00Z'))).toBe('not due');
		expect(bucket.taken).toHaveLength(1);
	});

	it('only nightly dumps count: a pre-migration dump after the hour does not replace it', async () => {
		const pre = backupKey('production', new Date('2026-11-10T06:10:00Z'), 'pre-migrate');
		const bucket = fakeBucket([pre, checksumKey(pre)]);
		const tick = createNightlyBackup({ ...bucket, schedule })!;
		expect(await tick(new Date('2026-11-10T06:20:00Z'))).toMatch(/^backup /);
	});

	it('applies the retention after each dump, and a failed dump is retried at the next check', async () => {
		const bucket = fakeBucket();
		const pruned: Date[] = [];
		let fail = true;
		const tick = createNightlyBackup({
			...bucket,
			take: async (at) => {
				if (fail) throw new Error('pg_dump exited with 1');
				return bucket.take(at);
			},
			prune: async (now) => {
				pruned.push(now);
				return ['backups/production/20261001T060000Z-nightly.dump'];
			},
			schedule
		})!;
		await expect(tick(new Date('2026-11-10T06:00:00Z'))).rejects.toThrow('pg_dump exited with 1');
		expect(pruned).toEqual([]);
		fail = false;
		expect(await tick(new Date('2026-11-10T06:15:00Z'))).toMatch(/, retention removed 1$/);
		expect(pruned).toEqual([new Date('2026-11-10T06:15:00Z')]);
	});
});
