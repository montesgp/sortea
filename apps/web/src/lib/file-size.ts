const decimal = new Intl.NumberFormat('es-AR', { maximumFractionDigits: 1 });

/** A file size as people read it in es-AR: "900 B", "2 KB", "1,5 MB". */
export function fileSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
	return `${decimal.format(bytes / (1024 * 1024))} MB`;
}
