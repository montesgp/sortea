import { VIDEO_MAX_BYTES } from '@sortea/domain';
import { describe, expect, it } from 'vitest';
import { bodyRejection, DEFAULT_BODY_LIMIT, VIDEO_UPLOAD_BODY_LIMIT } from './body-limit';

const MB = 1024 * 1024;
const request = (url: string, headers: Record<string, string> = {}, method = 'POST') => ({ method, url: new URL(url, 'http://localhost:5173'), headers: new Headers(headers) });

describe('request body limits (ADR 0009)', () => {
	it('keeps every route at 3 MB, enough for a 2 MB image in a form', () => {
		expect(DEFAULT_BODY_LIMIT).toBe(3 * MB);
		expect(bodyRejection(request('/admin/sitio?tab=imagenes&/upload', { 'content-length': String(3 * MB) }))).toBeNull();
		expect(bodyRejection(request('/admin/sitio?tab=imagenes&/upload', { 'content-length': String(3 * MB + 1) }))).toMatchObject({ status: 413 });
		expect(bodyRejection(request('/checkout', { 'content-length': String(4 * MB) }))).toMatchObject({ status: 413 });
		expect(bodyRejection(request('/admin/conciliacion?/upload', { 'content-length': String(10 * MB) }))).toMatchObject({ status: 413 });
	});

	it('lets only the video upload carry up to 50 MB plus the form overhead', () => {
		expect(VIDEO_UPLOAD_BODY_LIMIT).toBe(VIDEO_MAX_BYTES + MB);
		expect(bodyRejection(request('/admin/sitio?tab=imagenes&/uploadVideo', { 'content-length': String(VIDEO_MAX_BYTES + 1000) }))).toBeNull();
		expect(bodyRejection(request('/admin/sitio?/uploadVideo', { 'content-length': String(VIDEO_UPLOAD_BODY_LIMIT + 1) }))).toMatchObject({ status: 413 });
		// Same action name elsewhere, or on a GET, gets no exception.
		expect(bodyRejection(request('/admin/productos?/uploadVideo', { 'content-length': String(10 * MB) }))).toMatchObject({ status: 413 });
		expect(bodyRejection(request('/admin/sitio/?/uploadVideo', { 'content-length': String(10 * MB) }))).toMatchObject({ status: 413 });
	});

	it('refuses bodies of unknown length, which could otherwise grow up to the server-wide limit', () => {
		expect(bodyRejection(request('/checkout', { 'transfer-encoding': 'chunked' }))).toMatchObject({ status: 411 });
		expect(bodyRejection(request('/admin/sitio?/uploadVideo', { 'transfer-encoding': 'chunked' }))).toMatchObject({ status: 411 });
		expect(bodyRejection(request('/checkout', { 'content-length': 'abc' }))).toMatchObject({ status: 400 });
	});

	it('leaves requests without a body alone', () => {
		expect(bodyRejection(request('/tienda', {}, 'GET'))).toBeNull();
		expect(bodyRejection(request('/carrito?/clear', { 'content-length': '0' }))).toBeNull();
		expect(bodyRejection(request('/carrito?/clear'))).toBeNull();
	});
});
