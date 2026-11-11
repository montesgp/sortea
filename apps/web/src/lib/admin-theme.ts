/**
 * The back office's light or dark look (owner feedback 2026-11-10 S11). It uses
 * the same two palettes as the public site (the theme's `data-mode` variants),
 * but each browser chooses for itself: the choice lives in a cookie on /admin,
 * so the public site never sees it and keeps its organization's default.
 */
export const ADMIN_MODE_COOKIE = 'sortea_admin_mode';

export type Mode = 'dark' | 'light';
export type AdminModeChoice = 'site' | Mode | 'system';

/**
 * What the account page offers: light or dark only (console polish 2026-11-11, S2).
 * `site` (no cookie: the organization's default) and `system` (follow the device)
 * are still read, so a browser that chose them keeps its look until it picks one.
 */
export const adminModeChoices: readonly { value: Mode; label: string }[] = [
	{ value: 'light', label: 'Claro' },
	{ value: 'dark', label: 'Oscuro' }
];

const stored = new Set<string>(['light', 'dark', 'system']);

/** A stored choice; anything unknown counts as no choice. */
export function adminModeChoice(value: string | null | undefined): AdminModeChoice {
	return value && stored.has(value) ? (value as AdminModeChoice) : 'site';
}

/**
 * The mode a choice renders with. The server cannot see the device setting, so
 * `system` renders the site default and asks the page head to follow the
 * device (`data-mode-follow`), which it does before the first paint.
 */
export function adminMode(choice: AdminModeChoice, siteDefault: Mode | undefined): { mode: Mode; followSystem: boolean } {
	if (choice === 'light' || choice === 'dark') return { mode: choice, followSystem: false };
	return { mode: siteDefault ?? 'dark', followSystem: choice === 'system' };
}

/** The mode of any page: back-office pages honor the browser's choice, the public site its default. */
export function pageMode(input: { pathname: string; adminCookie: string | undefined; siteDefault: Mode | undefined }): { mode: Mode; followSystem: boolean } {
	const admin = input.pathname === '/admin' || input.pathname.startsWith('/admin/');
	return adminMode(admin ? adminModeChoice(input.adminCookie) : 'site', input.siteDefault);
}

/** Applies a new choice to the open page, as the server renders it on the next load. */
export function applyAdminMode(root: HTMLElement, choice: AdminModeChoice, siteDefault: Mode) {
	const { mode, followSystem } = adminMode(choice, siteDefault);
	root.dataset.modeFollow = followSystem ? 'system' : '';
	root.dataset.mode = followSystem ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : mode;
}
