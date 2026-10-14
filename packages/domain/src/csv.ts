/**
 * Minimal RFC 4180 CSV reading and writing. Exports are opened in
 * spreadsheets, so text cells that could start a formula are neutralised
 * (SECURITY: CSV injection).
 */

export type CsvCell = string | number | boolean | null | undefined;

const formulaStart = /^[=+\-@\t\r]/;

function encodeCell(cell: CsvCell): string {
	if (cell === null || cell === undefined) return '';
	let text = typeof cell === 'string' ? cell : String(cell);
	if (typeof cell === 'string' && formulaStart.test(text)) text = `'${text}`;
	return /[",;\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** Comma-separated, CRLF line endings, UTF-8 BOM so spreadsheets detect the encoding. */
export function toCsv(header: readonly string[], rows: readonly (readonly CsvCell[])[]): string {
	const lines = [header, ...rows].map((row) => row.map(encodeCell).join(','));
	return `\uFEFF${lines.join('\r\n')}\r\n`;
}

/** Parses delimited text with quoted fields. Empty trailing lines are dropped. */
export function parseCsv(text: string, delimiter: string): string[][] {
	const source = text.startsWith('\uFEFF') ? text.slice(1) : text;
	const rows: string[][] = [];
	let row: string[] = [];
	let field = '';
	let quoted = false;

	for (let index = 0; index < source.length; index++) {
		const char = source[index]!;
		if (quoted) {
			if (char === '"') {
				if (source[index + 1] === '"') {
					field += '"';
					index++;
				} else {
					quoted = false;
				}
			} else {
				field += char;
			}
			continue;
		}
		if (char === '"' && field === '') {
			quoted = true;
		} else if (char === delimiter) {
			row.push(field);
			field = '';
		} else if (char === '\n' || char === '\r') {
			if (char === '\r' && source[index + 1] === '\n') index++;
			row.push(field);
			rows.push(row);
			row = [];
			field = '';
		} else {
			field += char;
		}
	}
	if (field !== '' || row.length > 0) {
		row.push(field);
		rows.push(row);
	}
	return rows.filter((cells) => cells.some((cell) => cell.trim() !== ''));
}

/** Picks the delimiter that splits the header line into the most columns. */
export function detectDelimiter(headerLine: string): string {
	const candidates = [';', ',', '\t'];
	let best = ',';
	let bestCount = 0;
	for (const candidate of candidates) {
		const count = headerLine.split(candidate).length;
		if (count > bestCount) {
			best = candidate;
			bestCount = count;
		}
	}
	return best;
}
