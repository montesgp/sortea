import { backupsPrefix, listedBackups, nightlyBackupDue, type BackupSchedule } from '@sortea/db/backups';
import type { BackupResult } from '@sortea/db/backup-runner';

/**
 * The worker is the clock for the nightly database dump (ADR 0020, "Backups
 * of our own"): from `BACKUP_HOUR_UTC` on, it dumps when the bucket has no
 * nightly dump since that hour, then applies the retention. The bucket's
 * listing is the record, so restarts never dump twice for one night. Only a
 * dump with its checksum counts: one cut short before its sidecar was written
 * (restore refuses it) is taken again at the next check.
 */
export interface NightlyBackupOptions {
	schedule: BackupSchedule;
	/** Keys under a prefix of the bucket. */
	list(prefix: string): Promise<string[]>;
	take(at: Date): Promise<BackupResult>;
	/** Deletes what the retention no longer keeps; returns the deleted dumps. */
	prune(now: Date): Promise<string[]>;
}

export function createNightlyBackup(options: NightlyBackupOptions): ((now: Date) => Promise<string>) | null {
	if (!options.schedule.enabled) return null;
	const { environment, hourUtc } = options.schedule;
	return async (now) => {
		const [latest] = listedBackups(await options.list(backupsPrefix(environment)), environment).filter((entry) => entry.reason === 'nightly' && entry.complete);
		if (!nightlyBackupDue(now, hourUtc, latest?.at ?? null)) return 'not due';
		const result = await options.take(now);
		const pruned = await options.prune(now);
		return `backup ${result.key} (${result.bytes} bytes)${pruned.length > 0 ? `, retention removed ${pruned.length}` : ''}`;
	};
}
