import { createHash } from 'node:crypto';
import { and, asc, desc, eq, isNull, schema as s, sql, type Tx } from '@sortea/db';
import {
	checkLegalVersion,
	checkMediaUpload,
	cmsBlockKeys,
	faqInputSchema,
	isCmsBlockKey,
	isLegalBlockKey,
	legalVersionSetting,
	mediaKindOf,
	mediaRef,
	mediaStoragePath,
	parseCmsBlock,
	VIDEO_MAX_BYTES,
	type CmsBlockKey
} from '@sortea/domain';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { actorType, requireAdmin, type AdminContext } from '../lib/admin-context';
import { audit } from '../lib/audit';
import { ApiError, notFound, parse } from '../lib/errors';
import { assertOwnMedia, campaignMediaRefs, mediaInUse } from '../lib/media';

/**
 * Public site content (FR-CMS-04, ADR 0008). Editors save drafts and publish
 * them explicitly; every publish is kept as a revision. Images and videos go to
 * a public bucket under the organization's prefix, named by their hash.
 */

const LOCALE = 'es-AR';
const keyParams = z.object({ key: z.string().max(40) });
const idParams = z.object({ id: z.uuid() });
const draftBody = z.object({ content: z.unknown() });
const uploadQuery = z.object({ filename: z.string().trim().min(1).max(200) });
const faqBody = faqInputSchema.extend({ campaignId: z.uuid().nullable().optional() });
const faqPatch = faqInputSchema.partial().refine((value) => Object.keys(value).length > 0, 'Indicá qué cambiar');
const faqQuery = z.object({ campaignId: z.uuid().optional() });

type Block = typeof s.cmsBlocks.$inferSelect;

function actor(admin: AdminContext) {
	return { organizationId: admin.tenant.id, actorType: actorType(admin), actorId: admin.identity.userId };
}

function blockKey(params: unknown): CmsBlockKey {
	const { key } = parse(keyParams, params);
	if (!isCmsBlockKey(key)) throw notFound('Bloque');
	return key;
}

function blockView(key: CmsBlockKey, block: Block | undefined) {
	return {
		key,
		locale: block?.locale ?? LOCALE,
		version: block?.version ?? 1,
		published: block?.publishedAt ? block.content : null,
		publishedAt: block?.publishedAt ?? null,
		draft: block?.draft ?? null,
		draftUpdatedAt: block?.draftUpdatedAt ?? null
	};
}

async function loadBlock(tx: Tx, key: CmsBlockKey, lock = false): Promise<Block | undefined> {
	const query = tx.select().from(s.cmsBlocks).where(and(eq(s.cmsBlocks.key, key), eq(s.cmsBlocks.locale, LOCALE)));
	const [block] = lock ? await query.for('update') : await query;
	return block;
}

function validContent(key: CmsBlockKey, content: unknown): Record<string, unknown> {
	const parsed = parseCmsBlock(key, content);
	if (!parsed.success) throw new ApiError(400, 'invalid_content', 'Revisá los datos marcados', { issues: parsed.issues });
	return parsed.data;
}

function faqView(faq: typeof s.campaignFaqs.$inferSelect) {
	return { id: faq.id, campaignId: faq.campaignId, question: faq.question, answer: faq.answer, position: faq.position };
}

export async function cmsRoutes(app: FastifyInstance) {
	const { deps } = app;

	function mediaView(media: typeof s.cmsMedia.$inferSelect, inUse: boolean) {
		return {
			id: media.id,
			kind: mediaKindOf(media.storagePath),
			ref: mediaRef(media.storagePath),
			url: deps.media.publicUrl(media.storagePath),
			filename: media.filename,
			contentType: media.contentType,
			sizeBytes: media.sizeBytes,
			createdAt: media.createdAt,
			inUse
		};
	}

	app.get('/admin/cms', async (request) => {
		const admin = await requireAdmin(request, 'cms.manage');
		return deps.db.withTenant(admin.tenant.id, async (tx) => {
			const [blocks, media, revisions] = await Promise.all([
				tx.select().from(s.cmsBlocks).where(eq(s.cmsBlocks.locale, LOCALE)),
				tx.select().from(s.cmsMedia).orderBy(desc(s.cmsMedia.createdAt)),
				tx
					.select({ key: s.cmsBlockRevisions.key, version: s.cmsBlockRevisions.version, publishedAt: s.cmsBlockRevisions.publishedAt })
					.from(s.cmsBlockRevisions)
					.where(eq(s.cmsBlockRevisions.locale, LOCALE))
					.orderBy(desc(s.cmsBlockRevisions.version))
			]);
			const used = JSON.stringify([blocks.map((block) => [block.content, block.draft]), await campaignMediaRefs(tx)]);
			return {
				blocks: cmsBlockKeys.map((key) => ({
					...blockView(key, blocks.find((block) => block.key === key)),
					// Versions only; the content of one is fetched when it is restored.
					revisions: revisions.filter((revision) => revision.key === key).map(({ version, publishedAt }) => ({ version, publishedAt }))
				})),
				media: media.map((item) => mediaView(item, used.includes(mediaRef(item.storagePath)))),
				legal: admin.tenant.settings.legal
			};
		});
	});

	app.put('/admin/cms/blocks/:key', async (request) => {
		const admin = await requireAdmin(request, 'cms.manage');
		const key = blockKey(request.params);
		const content = validContent(key, parse(draftBody, request.body).content);
		return deps.db.withTenant(admin.tenant.id, async (tx) => {
			await assertOwnMedia(tx, admin.tenant.id, content);
			const now = deps.now();
			const [block] = await tx
				.insert(s.cmsBlocks)
				.values({ organizationId: admin.tenant.id, key, locale: LOCALE, content: null, draft: content, draftUpdatedAt: now, updatedBy: admin.identity.userId })
				.onConflictDoUpdate({
					target: [s.cmsBlocks.organizationId, s.cmsBlocks.key, s.cmsBlocks.locale],
					set: { draft: content, draftUpdatedAt: now, updatedBy: admin.identity.userId, updatedAt: now }
				})
				.returning();
			return blockView(key, block);
		});
	});

	app.delete('/admin/cms/blocks/:key/draft', async (request) => {
		const admin = await requireAdmin(request, 'cms.manage');
		const key = blockKey(request.params);
		return deps.db.withTenant(admin.tenant.id, async (tx) => {
			const block = await loadBlock(tx, key, true);
			if (!block?.draft) return blockView(key, block);
			const [updated] = await tx
				.update(s.cmsBlocks)
				.set({ draft: null, draftUpdatedAt: null, updatedBy: admin.identity.userId, updatedAt: deps.now() })
				.where(eq(s.cmsBlocks.id, block.id))
				.returning();
			await audit(tx, { ...actor(admin), action: 'cms.draft_discarded', targetType: 'cms_block', targetId: block.id, metadata: { key } });
			return blockView(key, updated);
		});
	});

	app.post('/admin/cms/blocks/:key/publish', async (request) => {
		const admin = await requireAdmin(request, 'cms.manage');
		const key = blockKey(request.params);
		const result = await deps.db.withTenant(admin.tenant.id, async (tx) => {
			const block = await loadBlock(tx, key, true);
			if (!block?.draft) throw new ApiError(409, 'nothing_to_publish', 'No hay cambios sin publicar');
			// Re-validated: the rules may have changed since the draft was saved.
			const content = validContent(key, block.draft);
			await assertOwnMedia(tx, admin.tenant.id, content);

			if (isLegalBlockKey(key)) {
				const [org] = await tx.select({ settings: s.organizations.settings }).from(s.organizations).for('update');
				const setting = legalVersionSetting[key];
				const version = String(content.version);
				const [otherText] = await tx
					.select({ id: s.cmsBlockRevisions.id })
					.from(s.cmsBlockRevisions)
					.where(
						and(
							eq(s.cmsBlockRevisions.blockId, block.id),
							sql`${s.cmsBlockRevisions.content}->>'version' = ${version}`,
							sql`${s.cmsBlockRevisions.content} <> ${JSON.stringify(content)}::jsonb`
						)
					)
					.limit(1);
				const check = checkLegalVersion(org!.settings.legal[setting], version, { usedForOtherText: Boolean(otherText) });
				if (!check.ok) {
					if (check.reason === 'version_unchanged') {
						throw new ApiError(409, 'legal_version_unchanged', 'Publicá el texto con una versión nueva: las compras anteriores aceptaron la versión vigente');
					}
					if (check.reason === 'version_used') {
						throw new ApiError(409, 'legal_version_used', 'Esa versión ya se publicó con otro texto. Usá una versión nueva');
					}
					throw new ApiError(400, 'legal_version_reserved', 'Esa versión está reservada');
				}
				await tx
					.update(s.organizations)
					.set({ settings: { ...org!.settings, legal: { ...org!.settings.legal, [setting]: version } }, updatedAt: deps.now() })
					.where(eq(s.organizations.id, admin.tenant.id));
			}

			const now = deps.now();
			const version = block.publishedAt ? block.version + 1 : block.version;
			const [updated] = await tx
				.update(s.cmsBlocks)
				.set({ content, version, publishedAt: now, publishedBy: admin.identity.userId, draft: null, draftUpdatedAt: null, updatedBy: admin.identity.userId, updatedAt: now })
				.where(eq(s.cmsBlocks.id, block.id))
				.returning();
			await tx.insert(s.cmsBlockRevisions).values({
				organizationId: admin.tenant.id,
				blockId: block.id,
				key,
				locale: block.locale,
				version,
				content,
				publishedBy: admin.identity.userId,
				publishedAt: now
			});
			await audit(tx, {
				...actor(admin),
				action: 'cms.published',
				targetType: 'cms_block',
				targetId: block.id,
				metadata: isLegalBlockKey(key) ? { key, version, legalVersion: content.version } : { key, version }
			});
			return blockView(key, updated);
		});
		// The legal version is part of the cached tenant settings.
		if (isLegalBlockKey(key)) app.tenants.invalidate();
		return result;
	});

	app.get('/admin/cms/blocks/:key/revisions', async (request) => {
		const admin = await requireAdmin(request, 'cms.manage');
		const key = blockKey(request.params);
		const revisions = await deps.db.withTenant(admin.tenant.id, (tx) =>
			tx
				.select()
				.from(s.cmsBlockRevisions)
				.where(and(eq(s.cmsBlockRevisions.key, key), eq(s.cmsBlockRevisions.locale, LOCALE)))
				.orderBy(desc(s.cmsBlockRevisions.version))
				.limit(50)
		);
		return {
			revisions: revisions.map((revision) => ({ version: revision.version, content: revision.content, publishedAt: revision.publishedAt, publishedBy: revision.publishedBy }))
		};
	});

	/**
	 * The only route with a large body limit: videos up to 50 MB (ADR 0009). The
	 * admin is checked before the body is read, so nobody else can make the API
	 * buffer one; images keep their 2 MB limit after sniffing.
	 */
	await app.register(async (media) => {
		media.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: VIDEO_MAX_BYTES }, (_request, body, done) => done(null, body));

		media.post('/admin/cms/media', { bodyLimit: VIDEO_MAX_BYTES, onRequest: async (request) => void (await requireAdmin(request, 'cms.manage')) }, async (request, reply) => {
			const admin = await requireAdmin(request, 'cms.manage');
			const { filename } = parse(uploadQuery, request.query);
			const bytes = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
			const check = checkMediaUpload(bytes);
			if (!check.ok && check.reason === 'unsupported') throw new ApiError(415, 'unsupported_media', 'Subí una imagen JPEG, PNG o WebP, o un video MP4 o WebM');
			if (!check.ok) {
				throw new ApiError(413, 'media_too_large', check.kind === 'image' ? 'La imagen supera 2 MB' : 'El video supera 50 MB. Para videos más largos usá un enlace de YouTube');
			}
			const sha256 = createHash('sha256').update(bytes).digest('hex');
			const storagePath = mediaStoragePath(admin.tenant.id, sha256, check.extension);
			const existing = await deps.db.withTenant(admin.tenant.id, (tx) => tx.select().from(s.cmsMedia).where(eq(s.cmsMedia.sha256, sha256)));
			if (existing[0]) return reply.status(200).send(mediaView(existing[0], false));

			// Upload first: an orphaned object is harmless, a row without its object is not.
			await deps.media.upload(storagePath, bytes, check.contentType);
			const created = await deps.db.withTenant(admin.tenant.id, async (tx) => {
				const [row] = await tx
					.insert(s.cmsMedia)
					.values({ organizationId: admin.tenant.id, storagePath, sha256, contentType: check.contentType, sizeBytes: bytes.length, filename, uploadedBy: admin.identity.userId })
					.onConflictDoNothing()
					.returning();
				if (!row) return null;
				await audit(tx, { ...actor(admin), action: 'cms.media_uploaded', targetType: 'cms_media', targetId: row.id, metadata: { filename, sizeBytes: bytes.length } });
				return row;
			});
			if (created) return reply.status(201).send(mediaView(created, false));
			const [raced] = await deps.db.withTenant(admin.tenant.id, (tx) => tx.select().from(s.cmsMedia).where(eq(s.cmsMedia.sha256, sha256)));
			return reply.status(200).send(mediaView(raced!, false));
		});
	});

	app.delete('/admin/cms/media/:id', async (request) => {
		const admin = await requireAdmin(request, 'cms.manage');
		const { id } = parse(idParams, request.params);
		await deps.db.withTenant(admin.tenant.id, async (tx) => {
			const [media] = await tx.select().from(s.cmsMedia).where(eq(s.cmsMedia.id, id)).for('update');
			if (!media) throw notFound('Archivo');
			if (await mediaInUse(tx, media.storagePath)) {
				throw new ApiError(409, 'media_in_use', 'El archivo se usa en el sitio, en un borrador, en una campaña o en un premio. Reemplazalo antes de borrarlo');
			}
			await tx.delete(s.cmsMedia).where(eq(s.cmsMedia.id, id));
			await audit(tx, { ...actor(admin), action: 'cms.media_deleted', targetType: 'cms_media', targetId: id, metadata: { filename: media.filename } });
			// Removed last, inside the transaction: if the bucket refuses, the row stays.
			await deps.media.remove(media.storagePath);
		});
		return { ok: true };
	});

	/** Site FAQs belong to the CMS; campaign FAQs to whoever manages campaigns. */
	const faqPermission = (campaignId: string | null | undefined) => (campaignId ? 'campaigns.manage' : 'cms.manage');

	app.get('/admin/faqs', async (request) => {
		const { campaignId } = parse(faqQuery, request.query);
		const admin = await requireAdmin(request, faqPermission(campaignId));
		const faqs = await deps.db.withTenant(admin.tenant.id, (tx) =>
			tx
				.select()
				.from(s.campaignFaqs)
				.where(campaignId ? eq(s.campaignFaqs.campaignId, campaignId) : isNull(s.campaignFaqs.campaignId))
				.orderBy(asc(s.campaignFaqs.position), asc(s.campaignFaqs.question))
		);
		return { faqs: faqs.map(faqView) };
	});

	app.post('/admin/faqs', async (request, reply) => {
		const body = parse(faqBody, request.body);
		const admin = await requireAdmin(request, faqPermission(body.campaignId));
		const faq = await deps.db.withTenant(admin.tenant.id, async (tx) => {
			if (body.campaignId) {
				const [campaign] = await tx.select({ id: s.campaigns.id }).from(s.campaigns).where(eq(s.campaigns.id, body.campaignId));
				if (!campaign) throw notFound('Campaña');
			}
			const [row] = await tx
				.insert(s.campaignFaqs)
				.values({ organizationId: admin.tenant.id, campaignId: body.campaignId ?? null, question: body.question, answer: body.answer, position: body.position ?? 0 })
				.returning();
			await audit(tx, { ...actor(admin), action: 'faq.created', targetType: 'faq', targetId: row!.id, metadata: { campaignId: row!.campaignId } });
			return row!;
		});
		return reply.status(201).send(faqView(faq));
	});

	async function loadFaqFor(request: Parameters<typeof requireAdmin>[0], id: string) {
		const admin = await requireAdmin(request);
		const [faq] = await deps.db.withTenant(admin.tenant.id, (tx) => tx.select().from(s.campaignFaqs).where(eq(s.campaignFaqs.id, id)));
		if (!faq) throw notFound('Pregunta');
		admin.assert(faqPermission(faq.campaignId));
		return { admin, faq };
	}

	app.patch('/admin/faqs/:id', async (request) => {
		const { id } = parse(idParams, request.params);
		const body = parse(faqPatch, request.body);
		const { admin } = await loadFaqFor(request, id);
		return deps.db.withTenant(admin.tenant.id, async (tx) => {
			const [row] = await tx.update(s.campaignFaqs).set(body).where(eq(s.campaignFaqs.id, id)).returning();
			if (!row) throw notFound('Pregunta');
			await audit(tx, { ...actor(admin), action: 'faq.updated', targetType: 'faq', targetId: id, metadata: { fields: Object.keys(body) } });
			return faqView(row);
		});
	});

	app.delete('/admin/faqs/:id', async (request) => {
		const { id } = parse(idParams, request.params);
		const { admin, faq } = await loadFaqFor(request, id);
		await deps.db.withTenant(admin.tenant.id, async (tx) => {
			await tx.delete(s.campaignFaqs).where(eq(s.campaignFaqs.id, id));
			await audit(tx, { ...actor(admin), action: 'faq.deleted', targetType: 'faq', targetId: id, metadata: { campaignId: faq.campaignId, question: faq.question } });
		});
		return { ok: true };
	});
}
