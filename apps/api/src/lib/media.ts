import { eq, inArray, or, schema as s, sql, type Tx } from '@sortea/db';
import { collectMediaRefs, mediaRef } from '@sortea/domain';
import { ApiError } from './errors';

/**
 * Library files (images and videos) are referenced as `media:<path>` by CMS
 * blocks, campaigns and prizes (ADR 0008, ADR 0009).
 *
 * Every file some content points to must be one this organization uploaded. The
 * rows stay share-locked until the content is written, so a delete (which takes
 * the row lock first) either waits and then finds the file in use, or wins and
 * the file is unknown here.
 */
export async function assertOwnMedia(tx: Tx, organizationId: string, content: unknown) {
	const paths = [...new Set(collectMediaRefs(content))];
	if (paths.length === 0) return;
	const known = paths.every((path) => path.startsWith(`${organizationId}/`))
		? await tx.select({ path: s.cmsMedia.storagePath }).from(s.cmsMedia).where(inArray(s.cmsMedia.storagePath, paths)).for('share')
		: [];
	const owned = new Set(known.map((row) => row.path));
	if (paths.some((path) => !owned.has(path))) {
		throw new ApiError(400, 'unknown_media', 'Una de las imágenes o videos no está en la biblioteca del sitio');
	}
}

/** Whether a published block, a draft, a campaign or a prize (its video or its image) points to the file. */
export async function mediaInUse(tx: Tx, storagePath: string): Promise<boolean> {
	const ref = mediaRef(storagePath);
	const pattern = `%${ref}%`;
	const [block, campaign, prize] = await Promise.all([
		tx
			.select({ id: s.cmsBlocks.id })
			.from(s.cmsBlocks)
			.where(or(sql`${s.cmsBlocks.content}::text like ${pattern}`, sql`${s.cmsBlocks.draft}::text like ${pattern}`))
			.limit(1),
		tx.select({ id: s.campaigns.id }).from(s.campaigns).where(eq(s.campaigns.video, ref)).limit(1),
		tx
			.select({ id: s.prizes.id })
			.from(s.prizes)
			.where(or(eq(s.prizes.video, ref), eq(s.prizes.imageUrl, ref)))
			.limit(1)
	]);
	return Boolean(block[0] ?? campaign[0] ?? prize[0]);
}

/** References used by campaigns and prizes, for the library's "in use" marks. */
export async function campaignMediaRefs(tx: Tx): Promise<string[]> {
	const [campaigns, prizes] = await Promise.all([
		tx.select({ video: s.campaigns.video }).from(s.campaigns),
		tx.select({ video: s.prizes.video, imageUrl: s.prizes.imageUrl }).from(s.prizes)
	]);
	return [...campaigns.map((row) => row.video), ...prizes.flatMap((row) => [row.video, row.imageUrl])].filter((ref): ref is string => Boolean(ref?.startsWith('media:')));
}
