import { describe, expect, it } from 'vitest';
import { ADMIN_MODE_COOKIE, adminModeChoice, adminModeChoices, pageMode } from './admin-theme';

// Owner feedback 2026-11-10 S11: the back office offers the site's light and dark
// variants (and the device's own setting), chosen per browser in a cookie on
// /admin. The public site keeps its organization's default (feedback 2026-10-19).

describe('back-office theme choice', () => {
	it('offers only light and dark (console polish 2026-11-11, S2)', () => {
		expect(adminModeChoices.map((choice) => [choice.value, choice.label])).toEqual([
			['light', 'Claro'],
			['dark', 'Oscuro']
		]);
		expect(ADMIN_MODE_COOKIE).toBe('sortea_admin_mode');
	});

	it('reads only known values; anything else falls back to the site default', () => {
		expect(adminModeChoice('light')).toBe('light');
		expect(adminModeChoice('dark')).toBe('dark');
		expect(adminModeChoice('system')).toBe('system');
		for (const value of [undefined, null, '', 'site', 'Light', 'blue', 'dark;', ' dark']) expect(adminModeChoice(value)).toBe('site');
	});
});

describe('page mode', () => {
	it('uses the stored choice on back-office pages', () => {
		expect(pageMode({ pathname: '/admin', adminCookie: 'light', siteDefault: 'dark' })).toEqual({ mode: 'light', followSystem: false });
		expect(pageMode({ pathname: '/admin/cuenta', adminCookie: 'dark', siteDefault: 'light' })).toEqual({ mode: 'dark', followSystem: false });
		expect(pageMode({ pathname: '/admin/login', adminCookie: 'light', siteDefault: 'dark' })).toEqual({ mode: 'light', followSystem: false });
	});

	it('follows the device after rendering the site default first', () => {
		expect(pageMode({ pathname: '/admin/pedidos', adminCookie: 'system', siteDefault: 'light' })).toEqual({ mode: 'light', followSystem: true });
	});

	it('falls back to the site default without a choice or with an invalid one', () => {
		expect(pageMode({ pathname: '/admin', adminCookie: undefined, siteDefault: 'light' })).toEqual({ mode: 'light', followSystem: false });
		expect(pageMode({ pathname: '/admin', adminCookie: 'purple', siteDefault: 'dark' })).toEqual({ mode: 'dark', followSystem: false });
		expect(pageMode({ pathname: '/admin', adminCookie: undefined, siteDefault: undefined })).toEqual({ mode: 'dark', followSystem: false });
	});

	it('never changes the public site', () => {
		for (const pathname of ['/', '/tienda', '/administracion', '/adminx'])
			expect(pageMode({ pathname, adminCookie: 'light', siteDefault: 'dark' })).toEqual({ mode: 'dark', followSystem: false });
	});
});
