import { beforeEach, describe, expect, it, vi } from 'vitest';

// A remembered browser (odd/tasks/launch-prep-2026-11-10.md, S1): the API
// verified the sign-in with the device token, so the code step is skipped; a
// temporary password is still replaced first.
const signIn = vi.fn();
vi.mock('#lib/server/admin-session.js', () => ({ signIn: (...args: unknown[]) => signIn(...args), authSession: vi.fn() }));
vi.mock('#lib/server/config.js', () => ({ serverEnv: () => 'test-internal-token-0123456789' }));
vi.mock('$app/env', () => ({ dev: false }));

const { actions } = await import('./+page.server');

let counter = 0;
function fakeEvent() {
	const jar = new Map<string, string>();
	return {
		cookies: { get: (name: string) => jar.get(name), set: (name: string, value: string) => void jar.set(name, value), delete: (name: string) => void jar.delete(name) },
		url: new URL('https://demo.localhost/admin/login'),
		// A fresh address each time, so the web's throttle never holds these tests back.
		getClientAddress: () => `198.51.100.${++counter}`,
		fetch,
		request: new Request('https://demo.localhost/admin/login', { method: 'POST', body: new URLSearchParams({ email: `owner${counter}@tallerdemo.local`, password: 'secret-password' }) })
	} as never;
}

const result = (verified: boolean, mustChangePassword = false) => ({ ok: true, mustChangePassword, totpConfirmed: true, mfaRequired: true, verified });

beforeEach(() => signIn.mockReset());

describe('sign-in action', () => {
	it('asks for the code when the sign-in is not verified yet', async () => {
		signIn.mockResolvedValue(result(false));
		await expect(actions.default(fakeEvent())).rejects.toMatchObject({ status: 303, location: '/admin/mfa' });
	});

	it('skips the code on a remembered browser', async () => {
		signIn.mockResolvedValue(result(true));
		await expect(actions.default(fakeEvent())).rejects.toMatchObject({ status: 303, location: '/admin' });
	});

	it('still sends a remembered browser to replace a temporary password', async () => {
		signIn.mockResolvedValue(result(true, true));
		await expect(actions.default(fakeEvent())).rejects.toMatchObject({ status: 303, location: '/admin/contrasena' });
	});
});
