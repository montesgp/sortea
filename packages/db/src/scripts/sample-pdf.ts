/**
 * Builds a small, valid single-page PDF so local development has a real file
 * behind the digital product. Replaced by the tenant's actual manual in
 * production through the admin upload.
 */
export function buildSamplePdf(lines: readonly string[]): Uint8Array {
	const escape = (text: string) => text.replace(/[\\()]/g, (match) => `\\${match}`);
	const toLatin1 = (text: string) => text.normalize('NFC');
	const stream = [
		'BT',
		'/F1 22 Tf',
		'72 760 Td',
		...lines.flatMap((line, index) => [index === 0 ? '' : '0 -30 Td', `(${escape(toLatin1(line))}) Tj`]).filter(Boolean),
		'ET'
	].join('\n');

	const objects = [
		'<< /Type /Catalog /Pages 2 0 R >>',
		'<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
		'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
		`<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`,
		'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'
	];

	let body = '%PDF-1.4\n';
	const offsets: number[] = [];
	objects.forEach((object, index) => {
		offsets.push(Buffer.byteLength(body, 'latin1'));
		body += `${index + 1} 0 obj\n${object}\nendobj\n`;
	});
	const xrefOffset = Buffer.byteLength(body, 'latin1');
	body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
	body += offsets.map((offset) => `${offset.toString().padStart(10, '0')} 00000 n \n`).join('');
	body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
	return Buffer.from(body, 'latin1');
}
