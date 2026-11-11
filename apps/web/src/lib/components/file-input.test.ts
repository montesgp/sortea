import type { Component } from 'svelte';
import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import { fileSize } from '../file-size';
import FileInput from './FileInput.svelte';

// S12 (odd/tasks/owner-feedback-2026-11-10.md): the browser's file box cuts long names, and a chosen
// file could not be discarded before uploading. The admin's file inputs show the whole name and
// size of the chosen file with a "Quitar" button, and the whole name of a file already uploaded.

const html = (props: Record<string, unknown>) => render(FileInput as Component, { props: props as never }).body;
const longName = 'calco-taller-demo-alta-resolucion-fondo-transparente-version-final-definitiva-2026.png';

describe('FileInput', () => {
	it('keeps the native input, its label target and its constraints', () => {
		const body = html({ id: 'image', name: 'image', accept: 'image/png', required: true });
		expect(body).toMatch(/<input[^>]*type="file"/);
		expect(body).toMatch(/<input[^>]*id="image"/);
		expect(body).toMatch(/<input[^>]*name="image"/);
		expect(body).toMatch(/<input[^>]*accept="image\/png"/);
		expect(body).toMatch(/<input[^>]*required/);
		expect(body).toMatch(/<input[^>]*aria-describedby="image-chosen"/);
	});

	it('renders the discard button, hidden until a file is chosen, and never asks to confirm', () => {
		const body = html({ id: 'report', name: 'report' });
		expect(body).toMatch(/<button[^>]*type="button"[^>]*hidden[^>]*>Quitar<\/button>/);
		expect(body).not.toContain('confirm');
	});

	it('shows the whole name of the file already uploaded, without cutting it', () => {
		const body = html({ id: 'pfile', name: 'imageFile', current: { name: longName, sizeBytes: 1_572_864 } });
		expect(body).toContain(longName);
		expect(body).toContain('Archivo actual:');
		expect(body).toContain('1,5 MB');
		expect(body).not.toMatch(/ellipsis|…/);
	});
});

describe('fileSize', () => {
	it('reads in es-AR units', () => {
		expect(fileSize(0)).toBe('0 B');
		expect(fileSize(900)).toBe('900 B');
		expect(fileSize(2048)).toBe('2 KB');
		expect(fileSize(1_572_864)).toBe('1,5 MB');
		expect(fileSize(50 * 1024 * 1024)).toBe('50 MB');
	});
});
