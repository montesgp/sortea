import { describe, expect, it } from 'vitest';
import { videoFields, videoFromForm } from './video-form';

const uploaded = 'media:6f1c2a5e-0b8d-4e7a-9c3f-2d1e0a9b8c7d/' + 'c'.repeat(64) + '.mp4';
const youtube = 'https://youtu.be/dQw4w9WgXcQ';
const form = (entries: Record<string, string>) => {
	const data = new FormData();
	for (const [key, value] of Object.entries(entries)) data.set(key, value);
	return data;
};

describe('campaign and prize video fields (S9)', () => {
	it('takes a library video or a YouTube link, or none', () => {
		expect(videoFromForm(form({ videoMedia: uploaded, videoUrl: '' }))).toEqual({ ok: true, video: uploaded });
		expect(videoFromForm(form({ videoMedia: '', videoUrl: ` ${youtube} ` }))).toEqual({ ok: true, video: youtube });
		expect(videoFromForm(form({ videoMedia: '', videoUrl: '' }))).toEqual({ ok: true, video: null });
	});

	it('asks for one of the two, never both', () => {
		expect(videoFromForm(form({ videoMedia: uploaded, videoUrl: youtube }))).toEqual({ ok: false, message: 'Elegí un video de la biblioteca o pegá un enlace de YouTube, no los dos' });
	});

	it('leaves the video untouched when the form has no video fields', () => {
		expect(videoFromForm(form({ title: 'Moto' }))).toEqual({ ok: true, video: undefined });
	});

	it('splits a saved video back into its field', () => {
		expect(videoFields(uploaded)).toEqual({ media: uploaded, url: '' });
		expect(videoFields(youtube)).toEqual({ media: '', url: youtube });
		expect(videoFields(null)).toEqual({ media: '', url: '' });
	});
});
