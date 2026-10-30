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

// S3 and S4 (feedback 2026-10-30): the footer shows the organization's Google
// Maps place with a location pin, and WhatsApp sits in the same row and style
// as the social networks. The floating WhatsApp button stays as it was.
const place = 'https://maps.app.goo.gl/3PR5ZLqycPPozsAe7';

test('the footer links the Google Maps place and lines WhatsApp up with the social networks', async ({ page }) => {
	await page.goto('/', { waitUntil: 'networkidle' });
	const footer = page.getByRole('contentinfo').getByRole('group', { name: 'Redes sociales' });
	const location = footer.getByRole('link', { name: 'Cómo llegar' });
	await expect(location).toHaveAttribute('href', place);
	await expect(location).toHaveAttribute('target', '_blank');
	await expect(location).toHaveAttribute('rel', 'noopener noreferrer');
	await expect(location.locator('svg')).toBeVisible();

	const chat = footer.getByRole('link', { name: 'WhatsApp', exact: true });
	await expect(chat).toHaveAttribute('href', 'https://wa.me/5492478407084?text=Hola%2C%20vengo%20desde%20la%20web');
	await expect(chat).toHaveAttribute('rel', 'noopener noreferrer');
	await expect(chat.locator('svg')).toBeVisible();

	// Every item is the same component: same list, same box, same icon size, same row height.
	const items = [footer.getByRole('link', { name: 'Instagram' }), footer.getByRole('link', { name: 'TikTok' }), footer.getByRole('link', { name: 'YouTube' }), chat, location];
	const style = (link: (typeof items)[number]) =>
		link.evaluate((element) => {
			const css = getComputedStyle(element);
			const icon = element.querySelector('svg')!.getBoundingClientRect();
			return {
				list: element.closest('ul')?.className,
				className: element.className,
				display: css.display,
				alignItems: css.alignItems,
				gap: css.gap,
				padding: css.padding,
				fontSize: css.fontSize,
				fontWeight: css.fontWeight,
				height: Math.round(element.getBoundingClientRect().height),
				icon: [Math.round(icon.width), Math.round(icon.height)]
			};
		});
	const reference = await style(items[0]!);
	expect(reference.display).toBe('inline-flex');
	for (const item of items.slice(1)) expect(await style(item)).toEqual(reference);
	// Each icon is vertically centered on its label's row.
	for (const item of items) {
		const offset = await item.evaluate((element) => {
			const box = element.getBoundingClientRect();
			const icon = element.querySelector('svg')!.getBoundingClientRect();
			return Math.abs(icon.top + icon.height / 2 - (box.top + box.height / 2));
		});
		expect(offset).toBeLessThanOrEqual(1);
	}

	// The floating button is unchanged and is not part of the footer.
	const floating = page.getByRole('link', { name: 'Escribinos por WhatsApp' });
	await expect(floating).toHaveCount(1);
	await expect(floating).toBeVisible();
	await expect(page.getByRole('contentinfo').getByRole('link', { name: 'Escribinos por WhatsApp' })).toHaveCount(0);
});

test('platform staff set the Google Maps place in the console', async ({ page }) => {
	test.skip(!password, 'Set E2E_ADMIN_PASSWORD to the password printed by the seed');
	await page.goto('/admin/login');
	await page.getByLabel('Email').fill('admin@sortea.local');
	await page.getByLabel('Contraseña').fill(password!);
	await page.getByRole('button', { name: 'Ingresar' }).click();
	await page.getByRole('link', { name: 'Organizaciones' }).click();
	await page.getByRole('link', { name: 'MotoGarage' }).click();
	await page.waitForLoadState('networkidle');
	const field = page.getByLabel('Ubicación en Google Maps');
	await expect(field).toHaveValue(place);
	try {
		await field.fill('https://www.openstreetmap.org/#map=15/-34.06/-60.10');
		await page.getByRole('button', { name: 'Guardar contacto' }).click();
		await expect(page.getByRole('alert')).toHaveText('Pegá el enlace de Google Maps completo, empezando por https://');
		await expect(page.getByLabel('Ubicación en Google Maps')).toHaveValue('https://www.openstreetmap.org/#map=15/-34.06/-60.10');
		await page.waitForLoadState('networkidle');

		await page.getByLabel('Ubicación en Google Maps').fill('');
		await page.getByRole('button', { name: 'Guardar contacto' }).click();
		await expect(page.getByRole('status')).toHaveText('Contacto guardado');
		await page.goto('/', { waitUntil: 'networkidle' });
		await expect(page.getByRole('contentinfo').getByRole('link', { name: 'Cómo llegar' })).toHaveCount(0);
	} finally {
		await page.goto('/admin/plataforma', { waitUntil: 'networkidle' });
		await page.getByRole('link', { name: 'MotoGarage' }).click();
		await page.waitForLoadState('networkidle');
		await page.getByLabel('Ubicación en Google Maps').fill(place);
		await page.getByRole('button', { name: 'Guardar contacto' }).click();
		await expect(page.getByRole('status')).toHaveText('Contacto guardado');
	}
	await page.goto('/', { waitUntil: 'networkidle' });
	await expect(page.getByRole('contentinfo').getByRole('link', { name: 'Cómo llegar' })).toHaveAttribute('href', place);
});
