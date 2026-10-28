import { expect, test, type Locator, type Page } from '@playwright/test';

// S8 (owner feedback 2026-10-28): a form the browser refuses shows a specific
// Spanish message under the field instead of the generic English bubble
// ("Please fill out this field.").

const english = /please (fill|select|enter|match|include|lengthen|shorten)/i;

/** Records, on the field itself, whether the browser bubble was suppressed (the site listens first). */
async function watchBubble(field: Locator) {
	await field.evaluate((element) => {
		element.addEventListener('invalid', (event) => element.setAttribute('data-bubble', event.defaultPrevented ? 'suppressed' : 'shown'));
	});
}

async function messageUnder(field: Locator): Promise<Locator> {
	const ids = ((await field.getAttribute('aria-describedby')) ?? '').split(/\s+/).filter(Boolean);
	expect(ids.length).toBeGreaterThan(0);
	return field.page().locator(ids.map((id) => `[id="${id}"].field-validation-error`).join(', '));
}

async function expectMessage(field: Locator, text: string) {
	await expect(field).toHaveAttribute('aria-invalid', 'true');
	const message = await messageUnder(field);
	await expect(message).toHaveText(text);
	// Under the field: below it on the page, and inside the same field block when there is one.
	const [fieldBox, messageBox] = [await field.boundingBox(), await message.boundingBox()];
	expect(messageBox!.y).toBeGreaterThanOrEqual(fieldBox!.y + fieldBox!.height - 1);
	expect(await message.textContent()).not.toMatch(english);
}

async function expectNoEnglish(page: Page) {
	await expect(page.locator('body')).not.toContainText(english);
}

test('consulta: the empty document and receipt forms say what is missing, in Spanish, under each field', async ({ page }) => {
	await page.goto('/consulta', { waitUntil: 'networkidle' });
	const documentNumber = page.locator('#documentNumber');
	await watchBubble(documentNumber);
	await page.getByRole('button', { name: 'Enviarme un código' }).click();

	await expectMessage(documentNumber, 'Completá el campo Número');
	await expect(documentNumber).toHaveAttribute('data-bubble', 'suppressed');
	await expect(documentNumber).toBeFocused();
	await expect(page).toHaveURL(/\/consulta$/);

	// The message goes away as soon as the field is right.
	await documentNumber.fill('30111222');
	await expect(documentNumber).not.toHaveAttribute('aria-invalid', 'true');
	await expect(page.locator('.field-validation-error')).toHaveCount(0);

	const reference = page.locator('#reference');
	const accessCode = page.locator('#accessCode');
	await page.getByRole('button', { name: 'Ver esta compra' }).click();
	await expectMessage(reference, 'Completá el campo Comprobante');
	await expectMessage(accessCode, 'Completá el campo Código de acceso');
	// The first refused field takes the focus.
	await expect(reference).toBeFocused();
	await expectNoEnglish(page);
});

test('admin login: a malformed email and an empty password are explained in Spanish', async ({ page }) => {
	await page.goto('/admin/login', { waitUntil: 'networkidle' });
	const email = page.getByLabel('Email');
	const password = page.getByLabel('Contraseña');
	await watchBubble(email);
	await email.fill('ana');
	await page.getByRole('button', { name: 'Ingresar' }).click();

	await expectMessage(email, 'Ingresá un email válido');
	await expectMessage(password, 'Completá el campo Contraseña');
	await expect(email).toHaveAttribute('data-bubble', 'suppressed');
	await expect(email).toBeFocused();
	await expect(page).toHaveURL(/\/admin\/login$/);

	// While it is still wrong the message follows what is typed; once right, it goes away.
	await email.fill('');
	await expectMessage(email, 'Completá el campo Email');
	await email.fill('ana@mail.com');
	await expect(page.locator('#email ~ .field-validation-error, .field:has(#email) .field-validation-error')).toHaveCount(0);
	await expect(email).not.toHaveAttribute('aria-invalid', 'true');
	await expectNoEnglish(page);
});

test('checkboxes, radio groups, selects and number ranges get their own message', async ({ page }) => {
	await page.goto('/consulta', { waitUntil: 'networkidle' });
	// Any form of the site is covered, including one rendered after the page loaded.
	await page.evaluate(() => {
		const form = document.createElement('form');
		form.id = 'probe';
		form.innerHTML = `
			<fieldset><legend>Talle</legend>
				<label><input type="radio" name="size" value="m" required /> M</label>
				<label><input type="radio" name="size" value="l" /> L</label>
			</fieldset>
			<div class="field"><label for="probe-province">Provincia</label><select id="probe-province" name="province" required><option value="">-</option><option>Buenos Aires</option></select></div>
			<div class="field"><label for="probe-quantity">Cantidad</label><input id="probe-quantity" name="quantity" type="number" min="1" max="5" value="9" /></div>
			<label class="check"><input type="checkbox" name="confirm" required /> Entiendo</label>
			<button>Probar</button>`;
		document.querySelector('main, #contenido, body')!.append(form);
	});
	const probe = page.locator('#probe');
	await probe.getByRole('button', { name: 'Probar' }).click();

	const [medium, large] = [probe.getByLabel('M'), probe.getByLabel('L')];
	await expectMessage(medium, 'Elegí una opción en Talle');
	// One message for the whole group, linked from every radio.
	await expect(large).toHaveAttribute('aria-describedby', (await medium.getAttribute('aria-describedby'))!);
	await expect(probe.locator('.field-validation-error')).toHaveCount(4);
	await expectMessage(probe.getByLabel('Provincia'), 'Elegí una opción en Provincia');
	await expectMessage(probe.getByLabel('Cantidad'), 'Ingresá un número menor o igual a 5');
	await expectMessage(probe.getByLabel('Entiendo'), 'Marcá esta casilla para continuar');
	await expect(medium).toBeFocused();

	await large.check();
	await probe.getByLabel('Provincia').selectOption('Buenos Aires');
	await probe.getByLabel('Cantidad').fill('0');
	await expectMessage(probe.getByLabel('Cantidad'), 'Ingresá un número mayor o igual a 1');
	await probe.getByLabel('Cantidad').fill('2');
	await probe.getByLabel('Entiendo').check();
	await expect(probe.locator('.field-validation-error')).toHaveCount(0);
	await expect(probe.locator('[aria-invalid]')).toHaveCount(0);
	await expectNoEnglish(page);
});

test('checkout keeps its own Spanish errors under each field after an empty submit', async ({ page }) => {
	await page.goto('/tienda', { waitUntil: 'networkidle' });
	await page.getByRole('article').filter({ hasText: 'Manual técnico' }).getByRole('button', { name: 'Agregar al carrito' }).click();
	await expect(page).toHaveURL(/\/carrito$/);
	await page.goto('/checkout', { waitUntil: 'networkidle' });

	await page.getByRole('button', { name: 'Ir a pagar con Mercado Pago' }).click();
	await expect(page.locator('#firstName-error')).toHaveText('Ingresá tu nombre');
	await expect(page.locator('#lastName-error')).toHaveText('Ingresá tu apellido');
	await expect(page.locator('#email-error')).toHaveText('Ingresá un email válido');
	await expect(page.getByLabel('Nombre', { exact: true })).toHaveAttribute('aria-invalid', 'true');
	// The server answers for this form; the site-wide messages never add a second one.
	await expect(page.locator('.field-validation-error')).toHaveCount(0);
	await expectNoEnglish(page);
});
