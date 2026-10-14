/** Privacy-enhanced embed URL for a YouTube link, or null if the link is not a YouTube video. */
export function youtubeEmbed(url: string | null): string | null {
	if (!url) return null;
	try {
		const parsed = new URL(url);
		const host = parsed.hostname.replace(/^www\./, '');
		let id: string | null = null;
		if (host === 'youtu.be') id = parsed.pathname.slice(1);
		else if (host === 'youtube.com' || host === 'm.youtube.com') {
			id = parsed.searchParams.get('v') ?? parsed.pathname.match(/^\/(?:live|embed|shorts)\/([\w-]+)/)?.[1] ?? null;
		}
		return id && /^[\w-]{6,20}$/.test(id) ? `https://www.youtube-nocookie.com/embed/${id}` : null;
	} catch {
		return null;
	}
}
