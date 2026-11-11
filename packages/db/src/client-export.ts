import { existsSync, mkdirSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseCmsBlock, type CmsBlockKey } from '@sortea/domain';
import { sha256Hex } from '@sortea/domain/server';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import ts from 'typescript';
import type { DatabaseHandle, Tx } from './client';
import { packFileName, readAll } from './client-files';
import { validateClientPack, type ClientPack, type FaqSeed, type ProductFileSeed, type ProductSeed } from './client-pack';
import { isLocalEndpoint, type ScopedStore } from './object-store';
import { productFileKinds, safeFilename } from './product-file';
import * as s from './schema';
import { isLocalDatabase } from './scripts/env';

/**
 * Writes an organization's current content back into its client pack
 * (`pnpm client:export <client>`), so the pack loads the site exactly as it is
 * in the local database: name, order prefix, settings, theme, every published
 * CMS block, the active products with their variants, prices, images and
 * suggestions, the site FAQs, and the real file of each digital product.
 *
 * It reads in a read-only transaction and never reads orders, contacts,
 * entries, payments, integrations, audit events, members or sessions. The
 * pack's hosts, members and campaign are not in the export: they stay as they
 * are written in `pack.ts`. Only the values that differ are rewritten, in
 * place, so comments, consts and formatting survive and a second run without
 * database changes leaves the file byte for byte.
 */

export class ClientExportRefusedError extends Error {}

/** What the export takes from the database; everything else in the pack is kept. */
const exportedKeys = ['name', 'orderPrefix', 'settings', 'theme', 'blocks', 'products', 'files', 'pitches', 'siteFaqs'] as const;

export interface ClientExportInput {
	client: string;
	packFile: string;
	/** `clients/<client>/files`, where the files are copied (kept outside git). */
	filesDir: string;
	/** The local bucket's `product-assets/`. */
	productFiles: ScopedStore;
}

export interface ExportedFile {
	productSlug: string;
	filename: string;
	sha256: string;
	sizeBytes: number;
	/** False when `filesDir` already had the same bytes. */
	copied: boolean;
}

export interface ClientExportResult {
	written: boolean;
	/** One line per section that changed, or `no changes`. */
	summary: string[];
	files: ExportedFile[];
}

export function assertExportTarget(databaseUrl: string, s3Endpoint: string | null | undefined): void {
	if (!isLocalDatabase(databaseUrl)) throw new ClientExportRefusedError(`pnpm client:export reads only the local database; DATABASE_URL points to ${new URL(databaseUrl).hostname}.`);
	if (!isLocalEndpoint(s3Endpoint)) {
		const where = s3Endpoint ? safeHost(s3Endpoint) : 'AWS S3 (no S3_ENDPOINT)';
		throw new ClientExportRefusedError(`pnpm client:export reads only the local bucket; S3_ENDPOINT points to ${where}.`);
	}
}

function safeHost(url: string): string {
	try {
		return new URL(url).host;
	} catch {
		return 'an invalid address';
	}
}

export async function exportClientPack(handle: DatabaseHandle, input: ClientExportInput): Promise<ClientExportResult> {
	const source = await readFile(input.packFile, 'utf8');
	const before = (await evaluatePackSource(source)) as ClientPack;
	if (before.slug !== input.client) throw new ClientExportRefusedError(`${input.packFile} has the slug ${before.slug}; the directory and the slug must match.`);

	// Resolving the slug is the one cross-tenant step; the transaction is read-only, so the export cannot write.
	const read = await handle.withPlatform((db) =>
		db.transaction(async (tx) => {
			await tx.execute(sql`set transaction read only`);
			return readOrganization(tx, input.client, before);
		})
	);

	const files: ExportedFile[] = [];
	const declared: Record<string, ProductFileSeed> = {};
	for (const asset of read.assets) {
		const bytes = await readAll(await input.productFiles.getStream(asset.storagePath));
		const sha256 = sha256Hex(bytes);
		const file: ProductFileSeed = { filename: asset.filename, sha256, contentType: asset.contentType };
		const target = join(input.filesDir, packFileName(file));
		const present = existsSync(target) && sha256Hex(new Uint8Array(await readFile(target))) === sha256;
		if (!present) {
			mkdirSync(input.filesDir, { recursive: true });
			await writeFile(target, bytes);
		}
		declared[asset.productSlug] = file;
		files.push({ productSlug: asset.productSlug, filename: asset.filename, sha256, sizeBytes: bytes.byteLength, copied: !present });
	}

	const exported: Partial<ClientPack> = { ...read.pack, ...(Object.keys(declared).length > 0 ? { files: declared } : {}) };
	const next = { ...before } as ClientPack;
	for (const key of exportedKeys) {
		if (exported[key] === undefined) delete next[key];
		else (next as unknown as Record<string, unknown>)[key] = exported[key];
	}
	const problems = validateClientPack(next);
	if (problems.length > 0) throw new ClientExportRefusedError(`The exported pack would not load, so ${input.packFile} is unchanged:\n  ${problems.join('\n  ')}`);

	const rewritten = rewritePackSource(source, before, next);
	const check = await evaluatePackSource(rewritten);
	if (stableJson(check) !== stableJson(next)) throw new Error(`Rewriting ${input.packFile} did not reproduce the exported values; the file is unchanged.`);
	const written = rewritten !== source;
	if (written) await writeFile(input.packFile, rewritten);
	return { written, summary: summarize(before, next), files };
}

interface ReadOrganization {
	pack: Pick<ClientPack, 'name' | 'orderPrefix' | 'settings' | 'theme' | 'blocks' | 'products' | 'pitches' | 'siteFaqs'>;
	assets: { productSlug: string; storagePath: string; filename: string; contentType: ProductFileSeed['contentType'] }[];
}

async function readOrganization(tx: Tx, slug: string, before: ClientPack): Promise<ReadOrganization> {
	const [org] = await tx
		.select({ id: s.organizations.id, name: s.organizations.name, orderPrefix: s.organizations.orderPrefix, settings: s.organizations.settings })
		.from(s.organizations)
		.where(eq(s.organizations.slug, slug));
	if (!org) throw new ClientExportRefusedError(`The database has no organization ${slug}.`);
	const organizationId = org.id;

	const [theme] = await tx
		.select({ tokens: s.organizationThemes.tokens })
		.from(s.organizationThemes)
		.where(and(eq(s.organizationThemes.organizationId, organizationId), eq(s.organizationThemes.isActive, true), isNull(s.organizationThemes.campaignId)));

	// Published content only: an unsaved editor draft is not what the site shows.
	const blockRows = await tx
		.select({ key: s.cmsBlocks.key, content: s.cmsBlocks.content, publishedAt: s.cmsBlocks.publishedAt })
		.from(s.cmsBlocks)
		.where(and(eq(s.cmsBlocks.organizationId, organizationId), eq(s.cmsBlocks.locale, 'es-AR')))
		.orderBy(asc(s.cmsBlocks.key));
	const published = blockRows.filter((row) => row.publishedAt && row.content);
	const blocks = inPackOrder(
		published.map((row) => ({ key: row.key as CmsBlockKey, content: blockContent(row.key as CmsBlockKey, row.content!, before.blocks.find((block) => block.key === row.key)?.content) })),
		before.blocks.map((block) => block.key),
		(block) => block.key
	);

	// Active products only: a draft or archived one would be created active by the pack.
	const productRows = await tx
		.select()
		.from(s.products)
		.where(and(eq(s.products.organizationId, organizationId), eq(s.products.status, 'active')))
		.orderBy(asc(s.products.position), asc(s.products.slug));
	const variantRows = await tx
		.select()
		.from(s.productVariants)
		.where(and(eq(s.productVariants.organizationId, organizationId), eq(s.productVariants.active, true)))
		.orderBy(asc(s.productVariants.createdAt), asc(s.productVariants.sku));
	const assetRows = await tx.select().from(s.productAssets).where(eq(s.productAssets.organizationId, organizationId)).orderBy(asc(s.productAssets.createdAt));

	const products: ProductSeed[] = [];
	const assets: ReadOrganization['assets'] = [];
	for (const row of productRows) {
		const previous = before.products.find((product) => product.slug === row.slug);
		const previousSkus = previous ? (previous.variants ?? [{ sku: previous.sku }]).map((variant) => variant.sku) : [];
		const variants = inPackOrder(
			variantRows.filter((variant) => variant.productId === row.id),
			previousSkus,
			(variant) => variant.sku
		);
		if (variants.length === 0) throw new ClientExportRefusedError(`Product ${row.slug} has no active variant; activate one or archive the product.`);
		const prices = new Set(variants.map((variant) => variant.priceMinor));
		if (prices.size > 1) throw new ClientExportRefusedError(`Product ${row.slug} has variants with different prices; a pack gives all variants of a product one price.`);
		const product: ProductSeed = { slug: row.slug, name: row.name, description: row.description, kind: row.kind, priceMinor: variants[0]!.priceMinor, sku: variants[0]!.sku };
		const single = variants.length === 1 && variants[0]!.name === row.name;
		if (single && variants[0]!.stock !== null) product.stock = variants[0]!.stock;
		if (row.imageUrl) product.imageUrl = row.imageUrl;
		const files = assetRows.filter((asset) => asset.productId === row.id);
		if (row.kind === 'digital') {
			if (files.length !== 1) throw new ClientExportRefusedError(`Digital product ${row.slug} has ${files.length} files; a pack gives each digital product exactly one.`);
			const file = files[0]!;
			const kind = productFileKinds.find((entry) => entry.contentType === file.contentType);
			if (!kind) throw new ClientExportRefusedError(`The file of ${row.slug} is ${file.contentType}, not a PDF or ZIP.`);
			if (!safeFilename.test(file.filename)) throw new ClientExportRefusedError(`The file of ${row.slug} is named ${file.filename}; rename it with pnpm db:product-file --name (letters A-Z, digits, dots, dashes, underscores).`);
			product.asset = true;
			assets.push({ productSlug: row.slug, storagePath: file.storagePath, filename: file.filename, contentType: kind.contentType });
		}
		if (!single) product.variants = variants.map((variant) => ({ sku: variant.sku, name: variant.name, ...(variant.stock !== null ? { stock: variant.stock } : {}) }));
		products.push(product);
	}

	// The pitch of each suggested product, as the loader writes them: one per product, in every other product's cart.
	const pitchRows = await tx
		.select({ variantId: s.offerItems.variantId, pitch: s.offerItems.pitch })
		.from(s.offerItems)
		.innerJoin(s.offers, eq(s.offers.id, s.offerItems.offerId))
		.where(and(eq(s.offerItems.organizationId, organizationId), eq(s.offers.kind, 'upsell'), eq(s.offers.active, true)))
		.orderBy(asc(s.offerItems.position));
	const pitches: Record<string, string> = {};
	for (const product of products) {
		const ids = new Set(variantRows.filter((variant) => productRows.find((row) => row.id === variant.productId)?.slug === product.slug).map((variant) => variant.id));
		const pitch = pitchRows.find((row) => ids.has(row.variantId) && row.pitch)?.pitch;
		if (pitch) pitches[product.slug] = pitch;
	}

	const faqRows = await tx
		.select({ question: s.campaignFaqs.question, answer: s.campaignFaqs.answer })
		.from(s.campaignFaqs)
		.where(and(eq(s.campaignFaqs.organizationId, organizationId), isNull(s.campaignFaqs.campaignId)))
		.orderBy(asc(s.campaignFaqs.position), asc(s.campaignFaqs.question));
	const siteFaqs: FaqSeed[] = faqRows.map((row) => ({ question: row.question, answer: row.answer }));

	return {
		pack: {
			name: org.name,
			orderPrefix: org.orderPrefix,
			settings: org.settings,
			theme: theme?.tokens ?? {},
			blocks,
			products,
			...(Object.keys(pitches).length > 0 ? { pitches } : {}),
			...(siteFaqs.length > 0 ? { siteFaqs } : {})
		},
		assets
	};
}

/** Items in the order the pack already lists them, then the new ones in their database order. */
function inPackOrder<T>(items: T[], order: string[], id: (item: T) => string): T[] {
	const known = order.flatMap((key) => items.filter((item) => id(item) === key));
	return [...known, ...items.filter((item) => !order.includes(id(item)))];
}

/**
 * A block's published content as the pack writes it. When it renders the same
 * as the pack's, the pack's is kept; otherwise top-level values that only
 * repeat a schema default are left out unless the pack already wrote them.
 */
function blockContent(key: CmsBlockKey, content: Record<string, unknown>, current: Record<string, unknown> | undefined): Record<string, unknown> {
	const rendered = parseCmsBlock(key, content);
	if (!rendered.success) throw new ClientExportRefusedError(`The published block ${key} does not pass its schema; publish it again from the site editor.`);
	if (current) {
		const previous = parseCmsBlock(key, current);
		if (previous.success && stableJson(previous.data) === stableJson(rendered.data)) return current;
	}
	const result = { ...content };
	for (const field of Object.keys(content)) {
		if (current && field in current) continue;
		const { [field]: _dropped, ...rest } = result;
		const without = parseCmsBlock(key, rest);
		if (without.success && stableJson(without.data) === stableJson(rendered.data)) delete result[field];
	}
	return result;
}

// ─── The pack as source ───────────────────────────────────────────────────

/** Runs a pack.ts source and returns its `pack`. A pack imports only types, so it needs no module. */
export async function evaluatePackSource(source: string): Promise<ClientPack> {
	const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
	const exports: { pack?: ClientPack } = {};
	const require = (name: string) => {
		throw new ClientExportRefusedError(`pack.ts imports ${name}; a pack may import only types.`);
	};
	new Function('exports', 'require', outputText)(exports, require);
	if (!exports.pack) throw new ClientExportRefusedError('pack.ts exports no `pack`.');
	return exports.pack;
}

interface Edit {
	start: number;
	end: number;
	text: string;
}

const LINE_WIDTH = 160;

/**
 * The pack source with the values that differ between `before` (what the
 * source evaluates to) and `next` rewritten in place. A const used once is
 * edited where it is declared; a const used more than once is replaced by a
 * literal where the value changed. Anything the rewriter cannot follow is
 * printed whole.
 */
export function rewritePackSource(source: string, before: ClientPack, next: ClientPack): string {
	const file = ts.createSourceFile('pack.ts', source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
	const eol = source.includes('\r\n') ? '\r\n' : '\n';
	const consts = new Map<string, ts.VariableDeclaration>();
	const references = new Map<string, ts.Node[]>();
	let packNode: ts.Expression | undefined;
	const visit = (node: ts.Node) => {
		if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && node.parent.flags & ts.NodeFlags.Const) {
			if (node.parent.parent.parent === file) consts.set(node.name.text, node);
			if (node.name.text === 'pack' && node.parent.parent.parent === file) packNode = node.initializer;
		}
		if (ts.isIdentifier(node) && isReference(node)) references.set(node.text, [...(references.get(node.text) ?? []), node]);
		ts.forEachChild(node, visit);
	};
	visit(file);
	if (!packNode) throw new ClientExportRefusedError('pack.ts has no top-level `const pack`.');

	const edits: Edit[] = [];
	const indentOf = (node: ts.Node) => {
		const start = node.getStart(file);
		const lineStart = source.lastIndexOf('\n', start - 1) + 1;
		return /^[\t ]*/.exec(source.slice(lineStart, start))![0];
	};
	const replace = (node: ts.Node, value: unknown) => edits.push({ start: node.getStart(file), end: node.getEnd(), text: printValue(value, indentOf(node)).replaceAll('\n', eol) });

	/** The node that holds the value: through parentheses, `as`, `satisfies`, and consts used once. */
	const resolve = (node: ts.Node): ts.Node => {
		if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) return resolve(node.expression);
		const name = ts.isShorthandPropertyAssignment(node) ? node.name : ts.isIdentifier(node) ? node : null;
		if (name) {
			const declaration = consts.get(name.text);
			if (declaration && (references.get(name.text) ?? []).length === 1) return resolve(declaration.initializer!);
			return node;
		}
		// `legal.terms` where every use of `legal` reads a different property of an object literal.
		if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
			const base = node.expression.text;
			const declaration = consts.get(base);
			const uses = references.get(base) ?? [];
			const reads = uses.map((use) => (ts.isPropertyAccessExpression(use.parent) && use.parent.expression === use ? use.parent.name.text : null));
			if (declaration && reads.every((read) => read !== null) && reads.filter((read) => read === node.name.text).length === 1) {
				const holder = resolveObject(declaration.initializer!);
				const property = holder?.properties.find((entry) => propertyName(entry) === node.name.text);
				if (property && ts.isPropertyAssignment(property)) return resolve(property.initializer);
			}
		}
		return node;
	};
	const resolveObject = (node: ts.Node): ts.ObjectLiteralExpression | null => {
		const target = resolve(node);
		return ts.isObjectLiteralExpression(target) ? target : null;
	};

	const update = (node: ts.Node, oldValue: unknown, newValue: unknown): void => {
		if (stableJson(oldValue) === stableJson(newValue)) return;
		const target = resolve(node);
		if (isPlainObject(newValue) && isPlainObject(oldValue) && ts.isObjectLiteralExpression(target) && target.properties.every((entry) => ts.isPropertyAssignment(entry) || ts.isShorthandPropertyAssignment(entry))) {
			updateObject(target, oldValue, newValue);
		} else if (Array.isArray(newValue) && Array.isArray(oldValue) && ts.isArrayLiteralExpression(target) && target.elements.every((entry) => !ts.isSpreadElement(entry) && !ts.isOmittedExpression(entry))) {
			updateArray(target, oldValue, newValue);
		} else if (typeof newValue === 'string' && typeof oldValue === 'string' && isJoin(target)) {
			const separator = (target.arguments[0] as ts.StringLiteral).text;
			update((target.expression as ts.PropertyAccessExpression).expression, oldValue.split(separator), newValue.split(separator));
		} else {
			replace(target, newValue);
		}
	};

	const updateObject = (node: ts.ObjectLiteralExpression, oldValue: Record<string, unknown>, newValue: Record<string, unknown>) => {
		const present = (value: Record<string, unknown>, key: string) => Object.hasOwn(value, key) && value[key] !== undefined;
		const kept = node.properties.filter((entry) => present(newValue, propertyName(entry)!));
		const added = Object.keys(newValue).filter((key) => present(newValue, key) && !node.properties.some((entry) => propertyName(entry) === key));
		if (kept.length === 0) return replace(node, newValue);
		for (const [index, entry] of node.properties.entries()) {
			const key = propertyName(entry)!;
			if (present(newValue, key)) {
				update(ts.isPropertyAssignment(entry) ? entry.initializer : entry, oldValue[key], newValue[key]);
				continue;
			}
			const following = node.properties[index + 1];
			const previous = node.properties[index - 1];
			if (following) edits.push({ start: entry.getStart(file), end: following.getStart(file), text: '' });
			else edits.push({ start: previous!.getEnd(), end: entry.getEnd(), text: '' });
		}
		appendItems(node, node.properties, added.map((key) => (indent: string) => `${printKey(key)}: ${printValue(newValue[key], indent)}`));
	};

	const updateArray = (node: ts.ArrayLiteralExpression, oldValue: unknown[], newValue: unknown[]) => {
		const elements = node.elements;
		if (newValue.length === 0 || elements.length === 0) return replace(node, newValue);
		for (const [index, element] of elements.entries()) {
			if (index < newValue.length) update(element, oldValue[index], newValue[index]);
		}
		if (newValue.length < elements.length) edits.push({ start: elements[newValue.length - 1]!.getEnd(), end: elements[elements.length - 1]!.getEnd(), text: '' });
		appendItems(node, elements, newValue.slice(elements.length).map((value) => (indent: string) => printValue(value, indent)));
	};

	/** New entries after the last one, inline or one per line like the list already is. */
	const appendItems = (node: ts.Node, items: ts.NodeArray<ts.Node>, printed: ((indent: string) => string)[]) => {
		if (printed.length === 0) return;
		const last = items[items.length - 1]!;
		const multiline = source.slice(node.getStart(file), node.getEnd()).includes('\n');
		const indent = multiline ? indentOf(last) : indentOf(node);
		const separator = multiline ? `,${eol}${indent}` : ', ';
		edits.push({ start: last.getEnd(), end: last.getEnd(), text: printed.map((print) => `${separator}${print(indent).replaceAll('\n', eol)}`).join('') });
	};

	const old = before as unknown as Record<string, unknown>;
	const now = next as unknown as Record<string, unknown>;
	update(packNode, old, now);

	let result = source;
	for (const edit of edits.sort((a, b) => b.start - a.start || b.end - a.end)) result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
	return result;
}

function isReference(node: ts.Identifier): boolean {
	const parent = node.parent;
	if (ts.isVariableDeclaration(parent) && parent.name === node) return false;
	if (ts.isPropertyAssignment(parent) && parent.name === node) return false;
	if (ts.isPropertyAccessExpression(parent) && parent.name === node) return false;
	if ((ts.isImportSpecifier(parent) || ts.isImportClause(parent)) && parent.name === node) return false;
	if (ts.isTypeReferenceNode(parent) || ts.isQualifiedName(parent) || ts.isParameter(parent) || ts.isPropertySignature(parent)) return false;
	return true;
}

function propertyName(entry: ts.ObjectLiteralElementLike): string | undefined {
	const name = entry.name;
	if (!name) return undefined;
	if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
	return undefined;
}

function isJoin(node: ts.Node): node is ts.CallExpression {
	return (
		ts.isCallExpression(node) &&
		ts.isPropertyAccessExpression(node.expression) &&
		node.expression.name.text === 'join' &&
		ts.isArrayLiteralExpression(node.expression.expression) &&
		node.arguments.length === 1 &&
		ts.isStringLiteral(node.arguments[0]!)
	);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function printKey(key: string): string {
	return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? key : printString(key);
}

function printString(value: string): string {
	return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\r/g, '\\r').replace(/\n/g, '\\n').replace(/\t/g, '\\t')}'`;
}

function printNumber(value: number): string {
	if (!Number.isInteger(value) || Math.abs(value) < 10_000) return String(value);
	return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, '_');
}

/** A value as the packs write it: single quotes, tabs, no trailing commas, long texts as joined lines. */
export function printValue(value: unknown, indent: string): string {
	const inner = `${indent}\t`;
	if (value === null || value === undefined) return 'null';
	if (typeof value === 'boolean') return String(value);
	if (typeof value === 'number') return printNumber(value);
	if (typeof value === 'string') {
		if (!value.includes('\n')) return printString(value);
		return `[\n${value
			.split('\n')
			.map((line) => `${inner}${printString(line)}`)
			.join(',\n')}\n${indent}].join('\\n')`;
	}
	const width = indent.length * 4;
	if (Array.isArray(value)) {
		if (value.length === 0) return '[]';
		const items = value.map((item) => printValue(item, inner));
		const inline = `[${items.join(', ')}]`;
		if (!value.some((item) => typeof item === 'object' && item !== null) && !inline.includes('\n') && width + inline.length <= LINE_WIDTH) return inline;
		return `[\n${items.map((item) => `${inner}${item}`).join(',\n')}\n${indent}]`;
	}
	const entries = Object.entries(value as Record<string, unknown>).filter(([, entry]) => entry !== undefined);
	if (entries.length === 0) return '{}';
	const items = entries.map(([key, entry]) => `${printKey(key)}: ${printValue(entry, inner)}`);
	const inline = `{ ${items.join(', ')} }`;
	if (!inline.includes('\n') && width + inline.length <= LINE_WIDTH) return inline;
	return `{\n${items.map((item) => `${inner}${item}`).join(',\n')}\n${indent}}`;
}

// ─── Summary ──────────────────────────────────────────────────────────────

function summarize(before: ClientPack, next: ClientPack): string[] {
	const lines: string[] = [];
	for (const key of ['name', 'orderPrefix'] as const) if (before[key] !== next[key]) lines.push(`${key}: changed`);
	for (const key of ['settings', 'theme'] as const) {
		const paths = changedPaths(before[key], next[key], '');
		if (paths.length > 0) lines.push(`${key}: ${paths.length} value${paths.length === 1 ? '' : 's'} changed (${paths.join(', ')})`);
	}
	const listed = (name: string, oldItems: [string, unknown][], newItems: [string, unknown][], showIds = true) => {
		const oldMap = new Map(oldItems);
		const newMap = new Map(newItems);
		const added = newItems.filter(([id]) => !oldMap.has(id)).map(([id]) => id);
		const changed = newItems.filter(([id, item]) => oldMap.has(id) && stableJson(oldMap.get(id)) !== stableJson(item)).map(([id]) => id);
		const removed = oldItems.filter(([id]) => !newMap.has(id)).map(([id]) => id);
		const parts = (
			[
				['added', added],
				['changed', changed],
				['removed', removed]
			] as const
		)
			.filter(([, ids]) => ids.length > 0)
			.map(([verb, ids]) => `${ids.length} ${verb}${showIds ? ` (${ids.join(', ')})` : ''}`);
		if (parts.length > 0) lines.push(`${name}: ${parts.join('; ')}`);
	};
	listed('blocks', before.blocks.map((block) => [block.key, block.content]), next.blocks.map((block) => [block.key, block.content]));
	listed('products', before.products.map((product) => [product.slug, product]), next.products.map((product) => [product.slug, product]));
	listed('files', Object.entries(before.files ?? {}), Object.entries(next.files ?? {}));
	listed('pitches', Object.entries(before.pitches ?? {}), Object.entries(next.pitches ?? {}));
	listed('siteFaqs', (before.siteFaqs ?? []).map((faq) => [faq.question, faq.answer]), (next.siteFaqs ?? []).map((faq) => [faq.question, faq.answer]), false);
	return lines.length > 0 ? lines : ['no changes'];
}

/** Leaf paths that differ, the old object's keys first, then the new keys in alphabetical order. */
function changedPaths(oldValue: unknown, newValue: unknown, prefix: string): string[] {
	if (stableJson(oldValue) === stableJson(newValue)) return [];
	if (!isPlainObject(oldValue) || !isPlainObject(newValue)) return [prefix || '(whole)'];
	const keys = [...Object.keys(oldValue), ...Object.keys(newValue).filter((key) => !Object.hasOwn(oldValue, key)).sort()];
	return keys.flatMap((key) => changedPaths(oldValue[key], newValue[key], prefix ? `${prefix}.${key}` : key));
}

/** JSON with sorted keys and no undefined values, so equal content compares equal whatever its key order. */
function stableJson(value: unknown): string {
	return JSON.stringify(value ?? null, (_key, entry: unknown) =>
		entry && typeof entry === 'object' && !Array.isArray(entry) ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a.localeCompare(b))) : entry
	);
}
