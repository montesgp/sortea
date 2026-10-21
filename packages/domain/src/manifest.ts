/**
 * Canonical participation manifest (DRAW-INTEGRITY 3-4, FR-ENTRY-05, AC-11).
 *
 * The manifest contains no personal data: each entry carries its public entry
 * number and a pseudonymous holder id. Serialization is deterministic so that
 * anyone holding the published file can recompute the same SHA-256.
 */
export interface ManifestEntry {
	readonly entryNumber: number;
	/** Pseudonymous, campaign-scoped holder id. Never a document number. */
	readonly holder: string;
	readonly status: 'eligible' | 'void';
}

/** The format of the manifests published before rounds existed; they stay valid and are never rewritten. */
export interface ManifestHeaderV1 {
	readonly format: 'sortea.manifest.v1';
	readonly campaignId: string;
	readonly ruleVersion: number;
	readonly closedAt: string;
	readonly eligibleCount: number;
	readonly voidCount: number;
}

/** One manifest per campaign round (ADR 0014 §5): the header records the round and the coupon digits. */
export interface ManifestHeaderV2 {
	readonly format: 'sortea.manifest.v2';
	readonly campaignId: string;
	readonly round: number;
	readonly ruleVersion: number;
	readonly entryDigits: number;
	readonly closedAt: string;
	readonly eligibleCount: number;
	readonly voidCount: number;
}

export type ManifestHeader = ManifestHeaderV1 | ManifestHeaderV2;

export interface CanonicalManifest {
	readonly header: ManifestHeader;
	readonly entries: readonly ManifestEntry[];
}

/** Builds the manifest of a round in the current format (v2). */
export function buildManifest(input: {
	campaignId: string;
	round: number;
	ruleVersion: number;
	entryDigits: number;
	closedAt: Date;
	entries: readonly ManifestEntry[];
}): CanonicalManifest {
	const entries = [...input.entries].sort((a, b) => a.entryNumber - b.entryNumber);
	for (let index = 1; index < entries.length; index++) {
		if (entries[index]!.entryNumber === entries[index - 1]!.entryNumber) {
			throw new Error(`Duplicate entry number ${entries[index]!.entryNumber} in manifest`);
		}
	}
	return {
		header: {
			format: 'sortea.manifest.v2',
			campaignId: input.campaignId,
			round: input.round,
			ruleVersion: input.ruleVersion,
			entryDigits: input.entryDigits,
			closedAt: input.closedAt.toISOString(),
			eligibleCount: entries.filter((entry) => entry.status === 'eligible').length,
			voidCount: entries.filter((entry) => entry.status === 'void').length
		},
		entries
	};
}

/**
 * One header line followed by one line per entry, `\n` terminated. Keys are
 * written in a fixed order, so the bytes do not depend on object insertion.
 * A parsed v1 manifest serializes back to its exact published bytes.
 */
export function serializeManifest(manifest: CanonicalManifest): string {
	const h = manifest.header;
	const header = JSON.stringify(
		h.format === 'sortea.manifest.v1'
			? { format: h.format, campaignId: h.campaignId, ruleVersion: h.ruleVersion, closedAt: h.closedAt, eligibleCount: h.eligibleCount, voidCount: h.voidCount }
			: {
					format: h.format,
					campaignId: h.campaignId,
					round: h.round,
					ruleVersion: h.ruleVersion,
					entryDigits: h.entryDigits,
					closedAt: h.closedAt,
					eligibleCount: h.eligibleCount,
					voidCount: h.voidCount
				}
	);
	const lines = manifest.entries.map((entry) =>
		JSON.stringify({ entryNumber: entry.entryNumber, holder: entry.holder, status: entry.status })
	);
	return [header, ...lines].join('\n') + '\n';
}

export function parseManifest(text: string): CanonicalManifest {
	const [headerLine, ...entryLines] = text.trimEnd().split('\n');
	if (!headerLine) throw new Error('Empty manifest');
	const header = JSON.parse(headerLine) as ManifestHeader;
	if (header.format !== 'sortea.manifest.v1' && header.format !== 'sortea.manifest.v2') throw new Error(`Unsupported manifest format ${(header as { format: unknown }).format}`);
	const entries = entryLines.map((line) => JSON.parse(line) as ManifestEntry);
	return { header, entries };
}
