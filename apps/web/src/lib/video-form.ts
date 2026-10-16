/**
 * The optional video of a campaign or a prize (S9): a video from the site
 * library (`videoMedia`, a `media:` reference) or a YouTube link (`videoUrl`).
 * The API validates both; the form only decides which one was chosen.
 */
export type VideoChoice = { ok: true; video: string | null | undefined } | { ok: false; message: string };

export function videoFromForm(form: FormData): VideoChoice {
	if (!form.has('videoMedia') && !form.has('videoUrl')) return { ok: true, video: undefined };
	const media = String(form.get('videoMedia') ?? '').trim();
	const url = String(form.get('videoUrl') ?? '').trim();
	if (media && url) return { ok: false, message: 'Elegí un video de la biblioteca o pegá un enlace de YouTube, no los dos' };
	return { ok: true, video: media || url || null };
}

/** A saved video back in its field. */
export function videoFields(video: string | null): { media: string; url: string } {
	if (!video) return { media: '', url: '' };
	return video.startsWith('media:') ? { media: video, url: '' } : { media: '', url: video };
}
