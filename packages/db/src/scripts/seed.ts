import { randomBytes } from 'node:crypto';
import { sha256Hex, parseKeyRing, sealSecret, maskSecret } from '@sortea/domain/server';
import type { ThemeOverrides } from '@sortea/domain';
import { createClient } from '@supabase/supabase-js';
import { eq } from 'drizzle-orm';
import { createDatabase, type Database } from '../client';
import * as s from '../schema';
import { assertLocalDatabase, databaseUrl } from './env';
import { buildSamplePdf } from './sample-pdf';

/**
 * Local development data. MotoGarage is tenant #1 with real brand assets and a
 * clearly labelled demo campaign; "Pista Sur" is a fictional second tenant used
 * to prove theming and isolation (AC-02, AC-10).
 *
 * No legal or PSP approval is seeded: the demo campaign stays `published` and
 * cannot open until someone records real approvals in the admin.
 */
const url = databaseUrl();
assertLocalDatabase(url);
const env = requireEnv(['SUPABASE_URL', 'SUPABASE_SECRET_KEY', 'SECRETS_KEY_RING', 'DEV_WEBHOOK_SECRET']);
const bucket = process.env.STORAGE_BUCKET ?? 'product-assets';
const mediaBucket = process.env.MEDIA_BUCKET ?? 'site-media';
const handle = createDatabase(url, { max: 2 });
const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY, { auth: { persistSession: false } });
const ring = parseKeyRing(env.SECRETS_KEY_RING);

const motoGarageTheme: ThemeOverrides = {
	defaultMode: 'dark',
	dark: {
		bg: '#0E0F11',
		surface: '#17191C',
		surface2: '#202328',
		text: '#F2F0EB',
		muted: '#A9A59C',
		border: '#2E3136',
		accent: '#D92626',
		accentText: '#FFFFFF',
		success: '#3CC48A',
		warning: '#E9B44C',
		danger: '#FF6A5C'
	},
	light: {
		bg: '#EFEDE8',
		surface: '#FFFFFF',
		surface2: '#E4E1DA',
		text: '#121315',
		muted: '#55524C',
		border: '#CFCBC2',
		accent: '#C21F1F',
		accentText: '#FFFFFF',
		success: '#17734F',
		warning: '#8A5A00',
		danger: '#B42318'
	},
	radius: 6,
	fontDisplay: 'big-shoulders',
	fontBody: 'archivo',
	density: 'comfortable'
};

const pistaSurTheme: ThemeOverrides = {
	defaultMode: 'light',
	light: {
		bg: '#F4F7FB',
		surface: '#FFFFFF',
		surface2: '#E6EDF6',
		text: '#0B1B33',
		muted: '#46566E',
		border: '#C9D5E5',
		accent: '#1747C9',
		accentText: '#FFFFFF',
		success: '#0F7A5C',
		warning: '#8A5A00',
		danger: '#B42318'
	},
	dark: { accent: '#F2C230', accentText: '#0B1B33' },
	radius: 18,
	fontDisplay: 'inter-tight',
	fontBody: 'inter-tight',
	density: 'comfortable'
};

/**
 * Example photos from Wikimedia Commons with their credits (see
 * apps/web/static/tenants/motogarage/restauraciones/CREDITS.md). They stand in
 * for the workshop's own photos and the page says so.
 */
// The page stays live; the home teaser and the menu link are off (owner feedback 2026-10-16).
const motoGarageGallery = {
	enabled: true,
	showOnHome: false,
	showInMenu: false,
	title: 'Restauraciones',
	lead: 'Motos clásicas que vuelven a la ruta: motor, chasis y pintura, pieza por pieza.',
	note: 'Fotos de ejemplo de motos clásicas, de Wikimedia Commons; pronto, los trabajos del taller.',
	items: [
		{
			image: '/tenants/motogarage/restauraciones/honda-cb750.jpg',
			alt: 'Honda CB750 Four de 1969 azul, con motor de cuatro cilindros y escapes cromados, en una exposición de clásicas',
			title: 'Honda CB750 Four',
			body: 'Cuatro cilindros y freno a disco adelante: la japonesa que cambió las motos grandes a fines de los sesenta.',
			credit: {
				author: 'Ronald Saunders from Warrington, UK',
				license: 'CC BY-SA 2.0',
				sourceUrl: 'https://commons.wikimedia.org/wiki/File:Flickr_-_ronsaunders47_-_HONDA_CB750._1969-2003._750cc_FOUR_CYLINDER..jpg'
			}
		},
		{
			image: '/tenants/motogarage/restauraciones/bmw-r60-2.jpg',
			alt: 'BMW R 60/2 negra de 1965 con filetes blancos, motor bóxer y alforjas de cuero, estacionada sobre adoquines',
			title: 'BMW R 60/2',
			body: 'Bóxer de 600 cc y transmisión por cardán. Una moto pensada para durar décadas.',
			credit: {
				author: 'Lothar Spurzem',
				license: 'CC BY-SA 2.0 de',
				sourceUrl: 'https://commons.wikimedia.org/wiki/File:BMW_R_60-2,_Bj._1965,_Hoske-Tank_(2014-09-13_7017).jpg'
			}
		},
		{
			image: '/tenants/motogarage/restauraciones/triumph-bonneville.jpg',
			alt: 'Triumph Bonneville T120 de 1967 bordó y blanca, vista desde atrás, en una muestra de clásicas sobre el pasto',
			title: 'Triumph Bonneville T120',
			body: 'El bicilíndrico británico de 650 cc que definió a la moto de los sesenta.',
			credit: { author: 'SG2012', license: 'CC BY 2.0', sourceUrl: 'https://commons.wikimedia.org/wiki/File:Triumph_Bonneville_T120_(1967).jpg' }
		},
		{
			image: '/tenants/motogarage/restauraciones/bsa-gold-star.jpg',
			alt: 'BSA Gold Star negra con filetes dorados, monocilíndrica, preparada como café racer sobre un elevador de taller',
			title: 'BSA Gold Star café racer',
			body: 'Monocilíndrica de 500 cc, la británica preferida para correr de café en café.',
			credit: {
				author: 'Ronald Saunders from Warrington, UK',
				license: 'CC BY-SA 2.0',
				sourceUrl: 'https://commons.wikimedia.org/wiki/File:Flickr_-_ronsaunders47_-_BSA_GOLD_STAR-CLASSIC_CAFE_RACER.jpg'
			}
		},
		{
			image: '/tenants/motogarage/restauraciones/royal-enfield-bullet.jpg',
			alt: 'Royal Enfield Bullet gris de 1954 con faro redondo y asiento negro, exhibida en un museo',
			title: 'Royal Enfield Bullet',
			body: 'Un diseño de los años cincuenta que se siguió fabricando durante décadas casi sin cambios.',
			credit: { author: 'Rikita', license: 'CC BY-SA 4.0', sourceUrl: 'https://commons.wikimedia.org/wiki/File:Royal_enfield_bullet.jpg' }
		}
	]
};

async function main(): Promise<void> {
	// Buckets are created even on a seeded database, so new ones appear without a reset.
	await ensureBucket();
	await ensureMediaBucket();
	const existing = await handle.withPlatform((db) =>
		db.select({ id: s.organizations.id }).from(s.organizations).where(eq(s.organizations.slug, 'motogarage'))
	);
	const password = process.env.SEED_ADMIN_PASSWORD ?? `dev-${randomBytes(6).toString('base64url')}`;
	if (existing.length > 0) {
		// Pista Sur is the second test tenant (AC-02, AC-10); bring it back if it was erased (ADR 0011).
		const pista = await handle.withPlatform((db) => db.select({ id: s.organizations.id }).from(s.organizations).where(eq(s.organizations.slug, 'pista-sur')));
		if (pista.length === 0) {
			const pistaUser = await ensureUser('owner@pistasur.local', password);
			await handle.withPlatform((db) => seedPistaSur(db, pistaUser));
			console.log('Restored Pista Sur, the second test organization (owner@pistasur.local).');
		}
		console.log('Seed data already present. Run `pnpm db:reset` for a clean database.');
		return;
	}

	const platformUser = await ensureUser('admin@sortea.local', password);
	const ownerUser = await ensureUser('owner@motogarage.local', password);
	const operatorUser = await ensureUser('operador@motogarage.local', password);
	const financeUser = await ensureUser('finanzas@motogarage.local', password);
	const pistaUser = await ensureUser('owner@pistasur.local', password);

	await handle.withPlatform(async (db) => {
		await db.insert(s.platformAdmins).values({ userId: platformUser, email: 'admin@sortea.local' });
		const motoGarage = await seedMotoGarage(db, ownerUser, operatorUser, financeUser);
		await seedPistaSur(db, pistaUser);
		await db.insert(s.auditEvents).values({
			organizationId: motoGarage,
			actorType: 'system',
			action: 'seed.completed',
			targetType: 'organization',
			targetId: motoGarage
		});
	});

	console.log('\nSeed complete. Local admin accounts (password for all):', password);
	console.log('  admin@sortea.local          platform_superadmin');
	console.log('  owner@motogarage.local      org_owner  (MotoGarage)');
	console.log('  operador@motogarage.local   campaign_operator (MotoGarage)');
	console.log('  finanzas@motogarage.local   finance_manager (MotoGarage)');
	console.log('  owner@pistasur.local        org_owner  (Pista Sur)');
}

async function seedMotoGarage(db: Database, ownerUser: string, operatorUser: string, financeUser: string): Promise<string> {
	const [org] = await db
		.insert(s.organizations)
		.values({
			slug: 'motogarage',
			name: 'MotoGarage',
			orderPrefix: 'MG',
			settings: {
				// WhatsApp as the digits wa.me expects: +54 9 2478 40-7084 (provisional, the owner will change it).
				contact: { city: 'Arrecifes, Buenos Aires', whatsapp: '5492478407084' },
				social: {
					instagram: 'https://www.instagram.com/motogaragearrecifes/',
					tiktok: 'https://www.tiktok.com/@tallermotogarage',
					youtube: 'https://www.youtube.com/@Tallermotogarage'
				},
				delivery: { pickupEnabled: true, shippingEnabled: true, shippingFeeMinor: 650_000, pickupNote: 'Retiro en el taller, coordinando por Instagram.' },
				legal: { termsVersion: '2026-10-draft', privacyVersion: '2026-10-draft' }
			}
		})
		.returning({ id: s.organizations.id });
	const organizationId = org!.id;

	await db.insert(s.organizationDomains).values([
		{ organizationId, hostname: 'localhost', isPrimary: true, verifiedAt: new Date() },
		{ organizationId, hostname: '127.0.0.1', verifiedAt: new Date() },
		{ organizationId, hostname: 'motogarage.localhost', verifiedAt: new Date() }
	]);
	await db.insert(s.organizationThemes).values({ organizationId, tokens: motoGarageTheme });
	await db.insert(s.organizationMembers).values([
		{ organizationId, userId: ownerUser, email: 'owner@motogarage.local', role: 'org_owner' },
		{ organizationId, userId: operatorUser, email: 'operador@motogarage.local', role: 'campaign_operator' },
		{ organizationId, userId: financeUser, email: 'finanzas@motogarage.local', role: 'finance_manager' }
	]);
	await seedFakeMercadoPago(db, organizationId);

	await seedCmsBlocks(db, [
		{
			organizationId,
			key: 'brand',
			publishedAt: new Date(),
			content: {
				logo: '/tenants/motogarage/logo.png',
				logoAlt: 'MotoGarage',
				tagline: 'Motos, motores y restauraciones.'
			}
		},
		{
			organizationId,
			key: 'home',
			publishedAt: new Date(),
			content: {
				heroStyle: 'garage',
				processStyle: 'pistons',
				heroTitle: 'Acá las motos vuelven a arrancar',
				heroLead: 'Taller, restauraciones, clásicas y coleccionables. Un garage hecho por y para gente de motor.',
				heroImage: '/tenants/motogarage/taller.jpg',
				heroImageAlt: 'Honda CRF supermotard sobre su caballete frente al cartel de MotoGarage',
				servicesTitle: 'Lo que pasa en el garage',
				services: [
					{ title: 'Taller', body: 'Diagnóstico, puesta a punto y mantenimiento para que la moto haga lo que tiene que hacer.' },
					{ title: 'Restauraciones', body: 'Desarme completo, motor, chasis y pintura. Cada pieza vuelve a su lugar con su historia.' },
					{ title: 'Clásicas', body: 'Motos con años encima que todavía tienen mucho para dar. Las cuidamos como se merecen.' },
					{ title: 'Coleccionables', body: 'Piezas, objetos y recuerdos para quienes viven la cultura de la moto.' }
				],
				processTitle: 'Así encaramos una restauración',
				process: [
					{ title: 'Desarme', body: 'Fotos, inventario y diagnóstico de cada pieza.' },
					{ title: 'Motor', body: 'Medición, rectificación y armado con repuestos que duren.' },
					{ title: 'Chasis y pintura', body: 'Estructura sana, terminación prolija.' },
					{ title: 'Entrega', body: 'Prueba en ruta y la moto vuelve a casa.' }
				],
				ctaTitle: 'Seguinos en redes',
				ctaBody: 'En Instagram, TikTok y YouTube mostramos los trabajos del taller, las restauraciones en curso y las novedades.'
			}
		},
		{ organizationId, key: 'gallery', publishedAt: new Date(), content: motoGarageGallery }
	]);

	const products = await seedCatalog(db, organizationId, [
		{
			slug: 'manual-tecnico',
			name: 'Manual técnico MotoGarage',
			description: 'Guía en PDF de mantenimiento preventivo: lubricación, transmisión, frenos y puesta a punto, con checklists para usar en el taller de casa.',
			kind: 'digital',
			priceMinor: 5_000_000,
			sku: 'MG-MANUAL-PDF',
			imageUrl: '/tenants/motogarage/manual-tecnico.webp',
			asset: true
		},
		{
			slug: 'checklist-digital',
			name: 'Checklist de viaje',
			description: 'Planilla imprimible para revisar la moto antes de salir a la ruta.',
			kind: 'digital',
			priceMinor: 1_500_000,
			sku: 'MG-CHECKLIST',
			imageUrl: '/tenants/motogarage/checklist-viaje.webp',
			asset: true
		},
		{
			slug: 'calcomania',
			name: 'Calcomanía MotoGarage',
			description: 'Calcomanía de vinilo con el logo de los pistones cruzados. 10 cm, resistente al agua y al sol.',
			kind: 'physical',
			priceMinor: 700_000,
			sku: 'MG-STICKER',
			imageUrl: '/tenants/motogarage/calcomania.jpg',
			stock: 200
		},
		{
			slug: 'remera',
			name: 'Remera MotoGarage',
			description: 'Remera negra de algodón con el escudo de los pistones cruzados estampado en el pecho.',
			kind: 'physical',
			priceMinor: 4_500_000,
			sku: 'MG-REMERA-S',
			imageUrl: '/tenants/motogarage/remera.jpg',
			variants: ['S', 'M', 'L', 'XL', 'XXL'].map((size) => ({ sku: `MG-REMERA-${size}`, name: `Talle ${size}`, stock: 10 }))
		}
	]);

	// Every product suggests the other three, so the cart always offers what is missing (S3, 2026-10-18).
	const pitches: Record<string, string> = {
		'manual-tecnico': 'Despieces, torques y mantenimiento en PDF.',
		'checklist-digital': 'Ideal para acompañar el manual.',
		calcomania: 'Para el casco, la caja de herramientas o el tanque.',
		remera: 'Negra, con el escudo de los pistones. Elegí tu talle.'
	};
	for (const anchor of Object.keys(pitches)) {
		const [offer] = await db
			.insert(s.offers)
			.values({ organizationId, kind: 'upsell', anchorProductId: products[anchor]!.productId, title: 'Sumá a tu pedido' })
			.returning({ id: s.offers.id });
		await db.insert(s.offerItems).values(
			Object.keys(pitches)
				.filter((slug) => slug !== anchor)
				.map((slug, position) => ({ organizationId, offerId: offer!.id, variantId: products[slug]!.variantId, position, pitch: pitches[slug]! }))
		);
	}

	await seedDemoCampaign(db, organizationId, products['manual-tecnico']!.variantId);
	return organizationId;
}

async function seedDemoCampaign(db: Database, organizationId: string, manualVariantId: string): Promise<void> {
	const [campaign] = await db
		.insert(s.campaigns)
		.values({
			organizationId,
			slug: 'tornado-300',
			title: 'Honda Tornado 300 0 km',
			subtitle: 'Campaña de demostración',
			summary:
				'Así se ve una campaña en la plataforma: premios, fechas, reglas y transparencia en un solo lugar. Esta campaña es una demostración y no acepta participaciones.',
			status: 'published',
			timezone: 'America/Argentina/Buenos_Aires',
			opensAt: new Date('2026-10-20T12:00:00-03:00'),
			closesAt: new Date('2026-11-28T20:00:00-03:00'),
			drawAt: new Date('2026-11-28T22:00:00-03:00'),
			requiredApprovals: ['legal', 'psp'],
			isDemo: true,
			seo: { title: 'Honda Tornado 300 0 km · MotoGarage', description: 'Campaña de demostración de MotoGarage.' }
		})
		.returning({ id: s.campaigns.id });
	const campaignId = campaign!.id;

	await db.insert(s.campaignApprovals).values([
		{ organizationId, campaignId, kind: 'legal', status: 'pending' },
		{ organizationId, campaignId, kind: 'psp', status: 'pending' }
	]);

	const body = [
		'# Bases y condiciones (borrador de demostración)',
		'',
		'Este texto es un **borrador** que muestra cómo se publican las bases. No es un reglamento vigente.',
		'',
		'- La modalidad, la autoridad de aplicación y el mecanismo de selección se completan con la aprobación legal.',
		'- Las reglas esenciales quedan bloqueadas al abrir la campaña. Cualquier cambio material genera una nueva versión publicada.',
		'- La lista de participaciones se congela al cierre y se publica su huella SHA-256 antes de la adjudicación.'
	].join('\n');
	await db.insert(s.campaignRuleVersions).values({
		organizationId,
		campaignId,
		version: 1,
		status: 'draft',
		bodyMarkdown: body,
		eligibility: { minAge: 18, residency: 'República Argentina', excluded: ['Personal de MotoGarage y familiares directos'] },
		entryRule: { mode: 'per_unit', entriesPerUnit: { [manualVariantId]: 1 }, maxEntriesPerIdentity: null },
		contentHash: sha256Hex(body)
	});

	await db.insert(s.prizes).values([
		{ organizationId, campaignId, position: 1, kind: 'vehicle', title: 'Honda Tornado 300 0 km', description: 'Patentamiento y flete a cargo de la organización, según bases.', declaredValueMinor: 850_000_000, quantity: 1, alternatesCount: 2, mechanism: 'quiniela' },
		{ organizationId, campaignId, position: 2, kind: 'cash', title: '$100.000 en efectivo', declaredValueMinor: 10_000_000, quantity: 10, alternatesCount: 1 },
		{ organizationId, campaignId, position: 3, kind: 'product', title: 'Kit de indumentaria MotoGarage', description: 'Remera, gorra y calcomanías.', declaredValueMinor: 6_000_000, quantity: 5, alternatesCount: 1 }
	]);

	await db.insert(s.campaignFaqs).values([
		{ organizationId, campaignId, position: 0, question: '¿Necesito crear una cuenta para comprar?', answer: 'No. Comprás con tu DNI y tu email, y recibís el comprobante y el acceso a tus archivos por correo.' },
		{ organizationId, campaignId, position: 1, question: '¿Cómo consulto mis compras?', answer: 'En Consultar ingresás tu DNI y te enviamos un código de un solo uso al email de tu compra. Nadie más puede ver tus datos.' },
		{ organizationId, campaignId, position: 2, question: '¿Qué significa la huella SHA-256?', answer: 'Al cierre publicamos la lista completa de participaciones sin datos personales y su huella. Cualquiera puede recalcularla y comprobar que la lista no cambió después.' },
		{ organizationId, campaignId: null, position: 0, question: '¿Hacen envíos?', answer: 'Sí, los productos físicos se envían a todo el país o se retiran en el taller.' },
		{
			organizationId,
			campaignId: null,
			position: 1,
			question: '¿Cómo y cuándo recibo los cursos en PDF y mis números?',
			answer:
				'Apenas Mercado Pago aprueba el pago te enviamos un email con el comprobante, los enlaces para descargar tus cursos en PDF y tus números para el sorteo. Si no lo ves, revisá spam o promociones. También podés consultar tu compra en «Mis compras» con tu documento.'
		},
		{
			organizationId,
			campaignId: null,
			position: 2,
			question: '¿Cómo y cuándo se realiza el sorteo?',
			answer:
				'El sorteo se hace en la fecha publicada en la campaña y se transmite en vivo por nuestro Instagram y nuestro canal de YouTube. El premio mayor sale de la Lotería Nacional; los demás premios se sortean con la app Sorteos.'
		},
		{
			organizationId,
			campaignId: null,
			position: 3,
			question: '¿Quién paga los gastos de transferencia y flete del premio?',
			answer: 'Los gastos de transferencia y el flete del premio están a cargo de MotoGarage.'
		}
	]);
}

async function seedPistaSur(db: Database, ownerUser: string): Promise<void> {
	const [org] = await db
		.insert(s.organizations)
		.values({
			slug: 'pista-sur',
			name: 'Pista Sur',
			orderPrefix: 'PS',
			settings: {
				contact: { city: 'Tenant de demostración' },
				social: {},
				delivery: { pickupEnabled: true, shippingEnabled: false, shippingFeeMinor: 0 },
				legal: { termsVersion: '2026-10-draft', privacyVersion: '2026-10-draft' }
			}
		})
		.returning({ id: s.organizations.id });
	const organizationId = org!.id;
	await db.insert(s.organizationDomains).values({ organizationId, hostname: 'pista.localhost', isPrimary: true, verifiedAt: new Date() });
	await db.insert(s.organizationThemes).values({ organizationId, tokens: pistaSurTheme });
	await db.insert(s.organizationMembers).values({ organizationId, userId: ownerUser, email: 'owner@pistasur.local', role: 'org_owner' });
	await seedFakeMercadoPago(db, organizationId);
	await seedCmsBlocks(db, [
		{ organizationId, key: 'brand', publishedAt: new Date(), content: { logo: null, logoAlt: 'Pista Sur', tagline: 'Tenant de demostración de la plataforma.' } },
		{
			organizationId,
			key: 'home',
			publishedAt: new Date(),
			content: {
				heroTitle: 'Pista Sur',
				heroLead: 'Segundo tenant de demostración: mismo código, otra marca, otros datos.',
				heroImage: null,
				services: [],
				process: [],
				ctaTitle: 'Tenant de demostración',
				ctaBody: 'Sirve para probar el aislamiento entre organizaciones y el cambio de tema.'
			}
		}
	]);
	await seedCatalog(db, organizationId, [
		{ slug: 'pase-anual', name: 'Pase anual de socios', description: 'Producto de demostración.', kind: 'digital', priceMinor: 4_500_000, sku: 'PS-PASS', asset: true }
	]);
}

interface ProductSeed {
	slug: string;
	name: string;
	description: string;
	kind: 'digital' | 'physical';
	priceMinor: number;
	sku: string;
	stock?: number;
	asset?: boolean;
	imageUrl?: string;
	/** Several variants (sizes) sharing the product's price; the first one is returned. */
	variants?: { sku: string; name: string; stock?: number }[];
}

async function seedCatalog(db: Database, organizationId: string, items: ProductSeed[]) {
	const result: Record<string, { productId: string; variantId: string }> = {};
	for (const [position, item] of items.entries()) {
		const [product] = await db
			.insert(s.products)
			.values({ organizationId, slug: item.slug, name: item.name, description: item.description, kind: item.kind, status: 'active', position, imageUrl: item.imageUrl ?? null })
			.returning({ id: s.products.id });
		const variants = item.variants ?? [{ sku: item.sku, name: item.name, stock: item.stock }];
		const [variant] = await db
			.insert(s.productVariants)
			.values(variants.map((entry) => ({ organizationId, productId: product!.id, sku: entry.sku, name: entry.name, priceMinor: item.priceMinor, stock: entry.stock ?? null })))
			.returning({ id: s.productVariants.id });
		if (item.asset) {
			// The real files are pushed with `pnpm db:product-file` (README, "Product files").
			const pdf = buildSamplePdf([item.name, 'Archivo de muestra para desarrollo local.', 'Reemplazalo con pnpm db:product-file.']);
			const storagePath = `${organizationId}/${product!.id}/${item.slug}.pdf`;
			const { error } = await supabase.storage.from(bucket).upload(storagePath, pdf, { contentType: 'application/pdf', upsert: true });
			if (error) throw new Error(`Upload failed for ${storagePath}: ${error.message}`);
			await db.insert(s.productAssets).values({
				organizationId,
				productId: product!.id,
				storagePath,
				filename: `${item.slug}.pdf`,
				contentType: 'application/pdf',
				sizeBytes: pdf.byteLength
			});
		}
		result[item.slug] = { productId: product!.id, variantId: variant!.id };
	}
	return result;
}

/**
 * Sandbox integration backed by the local payment simulator. The secrets are
 * sealed exactly like real ones, so the webhook path is identical.
 */
async function seedFakeMercadoPago(db: Database, organizationId: string): Promise<void> {
	const accessToken = `TEST-fake-${randomBytes(12).toString('hex')}`;
	// Same formula as simulatorCollectorId() in apps/api/src/payments/simulator.ts.
	const collectorId = `sim-${sha256Hex(accessToken).slice(0, 10)}`;
	const [integration] = await db
		.insert(s.organizationIntegrations)
		.values({
			organizationId,
			provider: 'mercadopago',
			mode: 'sandbox',
			publicConfig: { collectorId, publicKey: 'TEST-fake-public-key', simulator: 'true' },
			sealedSecrets: 'pending',
			keyVersion: ring.current,
			secretHint: maskSecret(accessToken)
		})
		.returning({ id: s.organizationIntegrations.id });
	const sealed = sealSecret(ring, JSON.stringify({ accessToken, webhookSecret: env.DEV_WEBHOOK_SECRET }), `${organizationId}:${integration!.id}`);
	await db.update(s.organizationIntegrations).set({ sealedSecrets: sealed }).where(eq(s.organizationIntegrations.id, integration!.id));
}

/**
 * Private bucket for product files. Illustrated manuals pass 50 MB (MotoGarage's
 * is 61 MB), so it takes up to 100 MB, as does supabase/config.toml. An existing
 * bucket is updated, so older local databases accept them without a reset.
 */
const bucketOptions = { public: false, fileSizeLimit: 100 * 1024 * 1024, allowedMimeTypes: ['application/pdf', 'application/zip'] };

async function ensureBucket(): Promise<void> {
	const { data } = await supabase.storage.getBucket(bucket);
	const { error } = data ? await supabase.storage.updateBucket(bucket, bucketOptions) : await supabase.storage.createBucket(bucket, bucketOptions);
	if (error) throw new Error(`Could not set up bucket ${bucket}: ${error.message}`);
}

/**
 * Public bucket for site images and videos (FR-CMS-04, S9); product files stay in
 * the private bucket. The API enforces the per-kind limits (images 2 MB, videos
 * 50 MB); the bucket only refuses anything else. An existing bucket is updated,
 * so local databases seeded before videos accept them without a reset.
 */
const mediaBucketOptions = { public: true, fileSizeLimit: 50 * 1024 * 1024, allowedMimeTypes: ['image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/webm'] };

async function ensureMediaBucket(): Promise<void> {
	const { data } = await supabase.storage.getBucket(mediaBucket);
	const { error } = data ? await supabase.storage.updateBucket(mediaBucket, mediaBucketOptions) : await supabase.storage.createBucket(mediaBucket, mediaBucketOptions);
	if (error) throw new Error(`Could not set up bucket ${mediaBucket}: ${error.message}`);
}

/** Seeded blocks are published, so they also get their first revision. */
async function seedCmsBlocks(db: Database, blocks: { organizationId: string; key: string; publishedAt: Date; content: Record<string, unknown> }[]) {
	const rows = await db.insert(s.cmsBlocks).values(blocks).returning();
	await db.insert(s.cmsBlockRevisions).values(
		rows.map((row) => ({ organizationId: row.organizationId, blockId: row.id, key: row.key, locale: row.locale, version: row.version, content: row.content!, publishedAt: row.publishedAt! }))
	);
}

async function ensureUser(email: string, password: string): Promise<string> {
	const { data: list, error: listError } = await supabase.auth.admin.listUsers({ perPage: 200 });
	if (listError) throw listError;
	const found = list.users.find((user) => user.email === email);
	if (found) {
		const { error } = await supabase.auth.admin.updateUserById(found.id, { password });
		if (error) throw error;
		return found.id;
	}
	const { data, error } = await supabase.auth.admin.createUser({ email, password, email_confirm: true });
	if (error) throw error;
	return data.user.id;
}

function requireEnv<K extends string>(keys: K[]): Record<K, string> {
	const missing = keys.filter((key) => !process.env[key]);
	if (missing.length) throw new Error(`Missing environment variables: ${missing.join(', ')}. Run \`pnpm setup:env\`.`);
	return Object.fromEntries(keys.map((key) => [key, process.env[key]!])) as Record<K, string>;
}

try {
	await main();
} finally {
	await handle.close();
}
