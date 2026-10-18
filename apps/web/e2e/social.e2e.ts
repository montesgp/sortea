import { expect, test, type Page } from '@playwright/test';

// S8 (feedback 2026-10-18): the home and the footer show every social network
// the organization set in the back office, and only those.

const password = process.env.E2E_ADMIN_PASSWORD;
const links = {
	Instagram: 'https://www.instagram.com/motogaragearrecifes/',
	TikTok: 'https://www.tiktok.com/@tallermotogarage',
	YouTube: 'https://www.youtube.com/@Tallermotogarage'
};

async function save(page: Page, values: Partial<Record<'Instagram' | 'TikTok' | 'YouTube' | 'Facebook', string>>) {
	const panel = page.getByRole('region', { name: 'Redes sociales' });
	for (const [label, value] of Object.entries(values)) await panel.getByLabel(label, { exact: true }).fill(value);
	await panel.getByRole('button', { name: 'Guardar redes' }).click();
	return panel;
}

test('the home and the footer link Instagram, TikTok and YouTube', async ({ page }) => {
	await page.goto('/', { waitUntil: 'networkidle' });
	const follow = page.getByRole('region', { name: 'Seguinos en redes' });
	const footer = page.getByRole('contentinfo').getByRole('group', { name: 'Redes sociales' });
	for (const [name, href] of Object.entries(links)) {
		await expect(follow.getByRole('link', { name })).toHaveAttribute('href', href);
		await expect(footer.getByRole('link', { name })).toHaveAttribute('href', href);
		await expect(footer.getByRole('link', { name })).toHaveAttribute('target', '_blank');
	}
	await expect(page.getByRole('link', { name: 'Facebook' })).toHaveCount(0);
});

test('the owner changes them in the back office and the site follows at once', async ({ page }) => {
	test.skip(!password, 'Set E2E_ADMIN_PASSWORD to the password printed by the seed');
	await page.goto('/admin/login');
	await page.getByLabel('Email').fill('owner@motogarage.local');
	await page.getByLabel('Contraseña').fill(password!);
	await page.getByRole('button', { name: 'Ingresar' }).click();
	await page.waitForURL(/\/admin$/);
	await page.goto('/admin/configuracion', { waitUntil: 'networkidle' });
	try {
		const refused = await save(page, { YouTube: 'https://www.tiktok.com/@tallermotogarage' });
		await expect(refused.getByRole('alert')).toHaveText('Revisá los enlaces marcados');
		await expect(refused.locator('#social-youtube-error')).toHaveText('Pegá el enlace completo de tu perfil de YouTube, empezando por https://');

		const panel = await save(page, { YouTube: links.YouTube, TikTok: '', Facebook: 'https://www.facebook.com/motogarage' });
		await expect(panel.getByRole('status')).toHaveText('Redes guardadas');
		await page.goto('/', { waitUntil: 'networkidle' });
		const footer = page.getByRole('contentinfo').getByRole('group', { name: 'Redes sociales' });
		await expect(footer.getByRole('link', { name: 'Facebook' })).toHaveAttribute('href', 'https://www.facebook.com/motogarage');
		await expect(footer.getByRole('link', { name: 'TikTok' })).toHaveCount(0);
	} finally {
		await page.goto('/admin/configuracion', { waitUntil: 'networkidle' });
		const restored = await save(page, { ...links, Facebook: '' });
		await expect(restored.getByRole('status')).toHaveText('Redes guardadas');
	}
});
