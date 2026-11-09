import type { ClientPack } from '../client-pack';

/**
 * Taller Demo: the fictional first organization of local development and of
 * the tests that need seeded content. It has the structure of a real client
 * (brand, theme, contact, site content, four products and a demo campaign) with
 * made-up data: the name, city, phone and social profiles are invented, the
 * logo, workshop and product images are generated placeholders, and the only
 * photos are openly licensed ones credited in the CREDITS.md files under
 * apps/web/static/tenants/taller-demo.
 *
 * No legal or PSP approval is included: the demo campaign stays `published` and
 * cannot open until someone records real approvals in the admin.
 */

const theme: ClientPack['theme'] = {
	defaultMode: 'dark',
	dark: {
		bg: '#0F1214',
		surface: '#181D20',
		surface2: '#21282C',
		text: '#EEF1F2',
		muted: '#A2ABAF',
		border: '#2D363A',
		accent: '#E8862A',
		accentText: '#111111',
		success: '#3CC48A',
		warning: '#E9B44C',
		danger: '#FF6A5C'
	},
	light: {
		bg: '#F1F3F4',
		surface: '#FFFFFF',
		surface2: '#E2E7E9',
		text: '#111618',
		muted: '#4E5A5F',
		border: '#C8D0D3',
		accent: '#A9500C',
		accentText: '#FFFFFF',
		success: '#17734F',
		warning: '#8A5A00',
		danger: '#B42318'
	},
	radius: 8,
	fontDisplay: 'big-shoulders',
	fontBody: 'archivo',
	density: 'comfortable'
};

/**
 * Example photos from Wikimedia Commons with their credits (see
 * apps/web/static/tenants/taller-demo/restauraciones/CREDITS.md); the page says
 * they are examples. The page stays live, off the home and the menu.
 */
const gallery = {
	enabled: true,
	showOnHome: false,
	showInMenu: false,
	title: 'Restauraciones',
	lead: 'Ejemplos de motos clásicas como las que llegan a un taller: motor, chasis y pintura.',
	note: 'Fotos de ejemplo de motos clásicas, de Wikimedia Commons; pronto, los trabajos del taller.',
	items: [
		{
			image: '/tenants/taller-demo/restauraciones/honda-cb750.jpg',
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
			image: '/tenants/taller-demo/restauraciones/bmw-r60-2.jpg',
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
			image: '/tenants/taller-demo/restauraciones/triumph-bonneville.jpg',
			alt: 'Triumph Bonneville T120 de 1967 bordó y blanca, vista desde atrás, en una muestra de clásicas sobre el pasto',
			title: 'Triumph Bonneville T120',
			body: 'El bicilíndrico británico de 650 cc que definió a la moto de los sesenta.',
			credit: { author: 'SG2012', license: 'CC BY 2.0', sourceUrl: 'https://commons.wikimedia.org/wiki/File:Triumph_Bonneville_T120_(1967).jpg' }
		},
		{
			image: '/tenants/taller-demo/restauraciones/bsa-gold-star.jpg',
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
			image: '/tenants/taller-demo/restauraciones/royal-enfield-bullet.jpg',
			alt: 'Royal Enfield Bullet gris de 1954 con faro redondo y asiento negro, exhibida en un museo',
			title: 'Royal Enfield Bullet',
			body: 'Un diseño de los años cincuenta que se siguió fabricando durante décadas casi sin cambios.',
			credit: { author: 'Rikita', license: 'CC BY-SA 4.0', sourceUrl: 'https://commons.wikimedia.org/wiki/File:Royal_enfield_bullet.jpg' }
		}
	]
};

/**
 * Terms and privacy policy as a labelled draft that describes what the
 * platform does today. They are the organization's content, published like any CMS block (ADR 0008), and counsel
 * replaces them before real sales. The version is what checkout records; a new
 * text needs a new version. No approval, permit or company number is stated.
 */
const legalVersion = 'demo-2026-11';
const draftNotice = {
	title: 'Borrador',
	body: 'Este texto es un borrador que describe cómo funciona hoy el sitio. Se reemplaza por el documento revisado por asesoría legal antes de habilitar ventas reales.'
};
const legal = {
	terms: {
		version: legalVersion,
		sections: [
			draftNotice,
			{
				title: 'Quién vende',
				body: 'Vende Taller Demo, un comercio ficticio de demostración, cuya actividad es la reparación de motocicletas y la venta de cursos de reparación y de productos relacionados. Taller Demo no comercializa sorteos ni participaciones. Los canales de atención se indican en la sección «Atención, consultas y reclamos».'
			},
			{
				title: 'Compra sin cuenta',
				body: 'Comprás sin crear una cuenta, con tu nombre, apellido, documento, email, país, provincia y ciudad. Antes de pagar aceptás estos términos y la política de privacidad, por separado. Guardamos la versión que aceptaste y la fecha.'
			},
			{
				title: 'Precio y pago',
				body: [
					'- Los precios publicados están expresados en pesos argentinos e incluyen los impuestos correspondientes.',
					'- El total lo calculamos nosotros con los precios vigentes y se muestra antes de pagar, con el costo de envío si corresponde.',
					'- El único medio de pago es Mercado Pago (Checkout Pro). Los datos de tu tarjeta o cuenta los recibe Mercado Pago, no nosotros.',
					'- La compra se confirma solo cuando Mercado Pago nos informa que el pago fue aprobado. Volver al sitio desde Mercado Pago no la confirma.',
					'- Un pedido sin pago aprobado vence a la hora de crearse.'
				].join('\n')
			},
			{
				title: 'Productos digitales',
				body: 'Cuando se aprueba el pago te enviamos por email el comprobante y los enlaces de descarga. Cada enlace es personal, vence a las 24 horas y permite hasta 5 descargas. Si vencen, pedí enlaces nuevos desde Consultar mis compras.'
			},
			{
				title: 'Productos físicos',
				body: 'Se retiran sin cargo en el taller o se envían a domicilio, según la opción que elijas. El envío a domicilio es solo dentro de Argentina, a la ciudad y provincia de tus datos, y su costo se informa antes de pagar.'
			},
			{
				title: 'Chances en campañas',
				body: [
					'- Las chances son un beneficio promocional que Taller Demo otorga exclusivamente con la compra de sus productos y servicios, mientras una campaña acepta participaciones. Las chances no se venden por separado, no tienen precio propio y no existe otra forma de participar en las campañas.',
					'- Cada producto indica cuántas chances otorga por unidad. Cada chance es un cupón numerado; la asignación de los cupones y la adjudicación de los premios se rigen por las bases de cada campaña.',
					'- Solo las personas mayores de 18 años pueden recibir chances. Para completar una compra que otorga chances debés declarar, antes de pagar, que sos mayor de 18 años; la declaración queda registrada con la compra.',
					'- Antes de entregar un premio, Taller Demo puede verificar la edad y la identidad de la persona ganadora. Si resulta menor de 18 años, la adjudicación se anula y el premio se asigna según las bases de la campaña.',
					'- Cuando se agotan los cupones de una campaña, no se aceptan nuevas compras de los productos que otorgan chances en ella.',
					'- La autorización para publicar la identidad del ganador es opcional y no afecta la participación ni la compra.'
				].join('\n')
			},
			{
				title: 'Arrepentimiento',
				body: [
					'Podés revocar tu compra dentro de los 10 días corridos contados desde la fecha de la compra o desde la entrega del producto, lo que ocurra último, sin costo alguno y sin necesidad de indicar el motivo (Ley 24.240 de Defensa del Consumidor, artículo 34, y Resolución 424/2020 de la Secretaría de Comercio Interior).',
					'',
					'- La solicitud se realiza mediante el «Botón de arrepentimiento», disponible al pie de todas las páginas del sitio, sin necesidad de registrarte. El botón abre WhatsApp con la solicitud preparada; si tenés el comprobante de la compra, incluilo.',
					'- Dentro de las 24 horas de recibida la solicitud te informamos por WhatsApp un código de seguimiento.',
					'- Si recibiste un producto físico, coordinamos por el mismo canal su devolución, sin costo para vos.',
					'- La revocación da lugar al reintegro del importe pagado a través de Mercado Pago y anula los cupones de esa compra, que dejan de participar en la campaña.'
				].join('\n')
			},
			{
				title: 'Reintegros y contracargos',
				body: [
					'- Un pago reintegrado o desconocido ante el medio de pago anula los cupones de esa compra. Los cupones anulados no participan, y el registro de lo ocurrido se conserva.',
					'- Si un pago se aprueba cuando ya no quedan cupones libres, la compra no recibe cupones y te reintegramos el pago.',
					'- Un pago aprobado después del cierre de una campaña conserva la compra, pero no suma chances.'
				].join('\n')
			},
			{
				title: 'Consultar tus compras',
				body: 'En Consultar mis compras ingresás tu documento y te enviamos un código de un solo uso, válido por 10 minutos, al email de tu compra. También podés entrar con el código de comprobante que ves al terminar la compra. Así ves tus compras, tus cupones y tus descargas.'
			},
			{
				title: 'Atención, consultas y reclamos',
				body: 'El canal de atención de Taller Demo es WhatsApp, al número que figura al pie del sitio. Por ese canal podés realizar cualquier consulta o reclamo sobre una compra, un producto, una entrega, una campaña o un premio, solicitar la revocación de una compra y ejercer tus derechos sobre tus datos personales.'
			}
		]
	},
	privacy: {
		version: legalVersion,
		sections: [
			draftNotice,
			{
				title: 'Quién trata tus datos',
				body: 'Taller Demo, un comercio ficticio de demostración, es responsable de los datos de sus compras y campañas. Las consultas y solicitudes sobre tus datos se reciben por WhatsApp, al número que figura al pie del sitio, como se indica en «Tus derechos».'
			},
			{
				title: 'Qué datos usamos',
				body: [
					'- Los que cargás al comprar: nombre, apellido, tipo y número de documento, email, país, provincia y ciudad, y, si los das, teléfono y la calle y el código postal para el envío.',
					'- Tus consentimientos y declaraciones, con la versión del texto y la fecha, incluida la declaración de ser mayor de 18 años cuando la compra otorga chances.',
					'- Lo que Mercado Pago nos informa del pago: estado, importe y número de operación. No recibimos los datos de tu tarjeta.',
					'- Si llegaste al sitio desde el link de una de nuestras publicaciones, cuál fue ese link y, cuando tu navegador lo informa, la red social desde la que llegaste. Estos datos no te identifican y se asocian a tu compra solo si comprás.'
				].join('\n')
			},
			{
				title: 'Para qué los usamos',
				body: 'Para procesar y entregar tu compra, enviarte el comprobante, los archivos y tus cupones, permitirte consultar tus compras, atender tus consultas, reclamos y solicitudes de arrepentimiento, contactar a los ganadores, verificar su identidad y su edad y entregar los premios, y cumplir las obligaciones legales. Los links de publicaciones por los que llegaste los usamos solo para saber qué publicaciones generaron compras.'
			},
			{
				title: 'Qué publicamos',
				body: [
					'Las listas públicas de cupones de una campaña no tienen datos personales: cada cupón figura con un identificador seudónimo que no permite saber quién sos.',
					'',
					'Si tu compra da chances en una campaña, podés autorizar, de forma opcional, que si un cupón de esa compra gana publiquemos tu nombre y apellido, tu ciudad y la cantidad de chances que obtuviste en la campaña. Con esa autorización, esos mismos datos pueden mostrarse durante la transmisión del sorteo cuando un cupón de esa compra resulta ganador o suplente. Si no lo autorizás, publicamos solo el número del cupón ganador con la leyenda «El ganador se reservó el derecho de no mostrar su identidad». Nunca publicamos tu documento, email, teléfono ni domicilio. Podés retirar esa autorización dejando la casilla sin marcar en una compra posterior o escribiéndonos por WhatsApp; una autorización posterior no se aplica a compras en las que no la diste.'
				].join('\n')
			},
			{
				title: 'Comunicaciones',
				body: 'Te escribimos por email solo por tu compra: el comprobante, los archivos, tus cupones, los códigos de consulta y los avisos sobre un reintegro. Si ganás, te contactamos con los datos de tu compra. No te enviamos novedades ni publicidad sin tu autorización expresa, que es opcional, y si no la diste no te escribimos para pedirla.'
			},
			{
				title: 'Con quién los compartimos',
				body: 'Con los proveedores que necesitamos para operar: Mercado Pago para el pago, el servicio que envía los emails y el que aloja el sitio y sus datos. No vendemos tus datos. Los entregamos a una autoridad solo cuando la ley lo exige.'
			},
			{
				title: 'Cuánto tiempo los guardamos',
				body: 'Las compras, los pagos, los cupones y la evidencia de los sorteos se conservan como registro de la venta y para que cada sorteo se pueda verificar. No se borran al pasar un plazo. El acceso está restringido a quienes lo necesitan y queda registrado.'
			},
			{
				title: 'Tus derechos',
				body: 'Podés ejercer los derechos de acceso, rectificación, actualización y supresión de tus datos personales previstos en la Ley 25.326. WhatsApp, al número que figura al pie del sitio, es el canal para cualquier consulta, reclamo o solicitud sobre tus datos personales, incluido el retiro de la autorización para publicar tu identidad. Si pedís la supresión y debemos conservar el registro de la compra o del sorteo, bloqueamos tus datos: se guardan solo para esa obligación y no se usan para nada más. La Agencia de Acceso a la Información Pública es el órgano de control de la Ley 25.326.'
			},
			{
				title: 'Cookies y almacenamiento',
				body: [
					'No usamos cookies de publicidad ni rastreadores de terceros. El sitio usa solo cookies propias y el almacenamiento de tu navegador:',
					'',
					'- una cookie con tu carrito, por 7 días;',
					'- una cookie con el acceso al comprobante de tu última compra, por 6 horas;',
					'- una cookie con tu sesión de Consultar mis compras, por 30 minutos;',
					'- una cookie con los links de nuestras publicaciones por los que llegaste al sitio y, cuando tu navegador informa desde qué red social llegaste, esa red. No contiene datos personales. Cada link se guarda hasta el cierre de la campaña a la que corresponde y la red, por 30 días. La usamos solo para saber qué publicaciones generaron compras, y se asocia a una compra solo cuando comprás;',
					'- lo que escribís en el checkout, guardado solo en tu navegador mientras la pestaña está abierta para que no lo pierdas si volvés al carrito; no se envía ni guarda tus consentimientos.',
					'',
					'Los videos de YouTube se muestran con su modo de privacidad mejorada; al reproducirlos, YouTube aplica su propia política.'
				].join('\n')
			}
		]
	}
};

// Chances per unit of each product, the same for all its variants. They are progressive: the price per chance falls as the price rises ($7.000, $5.000, $4.091, $3.571), so no combination
// of cheaper products gives more chances than a more expensive one for the same money.
const chancesPerUnit = { 'manual-tecnico': 14, 'checklist-digital': 3, calcomania: 1, remera: 11 };

// Every prize is decided by the Quiniela and the winner pays the vehicle's delivery and transfer.
const rules = [
	'# Bases y condiciones (borrador de demostración)',
	'',
	'Este texto es un **borrador** que muestra cómo se publican las bases. No es un reglamento vigente.',
	'',
	'## Naturaleza de la promoción',
	'',
	'- Taller Demo se dedica a la reparación de motocicletas y a la venta de cursos de reparación y de productos relacionados. Esta campaña es una acción promocional de esa actividad.',
	'- Las chances son un beneficio promocional que se otorga exclusivamente con la compra de los productos y servicios de Taller Demo que lo indican. Las chances no se venden por separado, no tienen precio propio y no existe otra forma de participar.',
	'',
	'## Premios',
	'',
	'1. Una Honda Tornado 300 0 km. La entrega del vehículo y los gastos de patentamiento y transferencia están a cargo del ganador.',
	'2. Cinco premios de $100.000 en efectivo.',
	'3. Dos kits de indumentaria Taller Demo (remera, gorra y calcomanías).',
	'',
	'## Cupones',
	'',
	'- Cada chance es un cupón numerado del 0000 al 9999, y cada cupón vale una chance. Los números se asignan en orden cuando se confirma el pago.',
	'- Cada producto de la tienda indica cuántas chances da por unidad mientras la campaña acepta participaciones.',
	'- La asignación de chances es progresiva: cuanto mayor es el precio de un producto, menor es el importe correspondiente a cada chance que otorga, de modo que los productos de mayor precio otorgan proporcionalmente más chances.',
	'- Al iniciar el pago, las chances del pedido quedan reservadas. Si el pago no se aprueba dentro de la hora, el pedido vence y la reserva se libera.',
	'- Cuando no quedan cupones libres, no se aceptan nuevas compras de los productos que otorgan chances. Si un pago se aprueba sin cupones libres, la compra no recibe cupones y el pago se reintegra.',
	'- Un pago reintegrado o desconocido ante el medio de pago anula sus cupones. Un pago aprobado después del cierre conserva la compra, pero no suma chances.',
	'- La revocación de una compra mediante el «Botón de arrepentimiento», dentro de los 10 días corridos previstos por la Ley 24.240, reintegra el pago y anula los cupones de esa compra.',
	'',
	'## Quién puede participar',
	'',
	'- Solo pueden recibir chances las personas mayores de 18 años residentes en la República Argentina.',
	'- Antes de pagar una compra que otorga chances, quien compra declara ser mayor de 18 años. La declaración queda registrada con la compra y sin ella la compra no se puede completar.',
	'- No participan el personal de Taller Demo ni sus familiares directos.',
	'',
	'## Cómo se adjudican los premios',
	'',
	'- Al cierre se congela la lista de cupones y se publican la lista, sin datos personales, y su huella SHA-256.',
	'- Todos los premios salen de los 20 números del extracto oficial de una jugada de la Quiniela realizada después de esa publicación. La jugada, su fecha y hora y el enlace al extracto oficial se publican en el registro de transparencia.',
	'- Los 20 números se leen en su orden oficial, del 1.º al 20.º. Un número gana cuando coincide con un cupón válido de la lista publicada que todavía no ganó ningún premio.',
	'- Los premios se completan en este orden: la moto, después los premios en efectivo y por último los kits. El primer número que coincide gana la moto, los cinco siguientes ganan los premios en efectivo y los dos siguientes, los kits.',
	'- Los números que coinciden después definen los suplentes, en el mismo orden: dos para la moto y uno para cada premio en efectivo y cada kit.',
	'- Un número repetido o un cupón que ya ganó no cuenta. Cada premio tiene un único ganador, y una misma persona puede ganar más de un premio con cupones distintos.',
	'- La plataforma no hace un sorteo propio: cualquiera puede comprobar el resultado con la lista publicada y el extracto oficial.',
	'',
	'## Premios vacantes',
	'',
	'- Si los números del extracto no alcanzan para todos los premios, los premios sin cupón ganador quedan vacantes. Los premios ya ganados se mantienen.',
	'- La campaña se reabre para una nueva ronda, con una nueva fecha de cierre anunciada en el registro público. Todos los cupones vendidos siguen participando.',
	'- Al cierre de cada ronda se publica una nueva lista con su huella, y la siguiente jugada de la Quiniela decide solo los premios vacantes, con las mismas reglas.',
	'',
	'## Resultados y ganadores',
	'',
	'- Una vez publicados los resultados, la página de la campaña muestra por premio la cantidad entregada y el cupón ganador de cada unidad. El nombre, la ciudad y la cantidad de chances del ganador se publican solo si lo autorizó al comprar; de lo contrario se indica «El ganador se reservó el derecho de no mostrar su identidad». Durante la transmisión, el organizador puede invitar al ganador a identificarse voluntariamente.',
	'- Nunca se publican el documento, el email, el teléfono ni el domicilio del ganador. La autorización es opcional y no cambia las chances.',
	'',
	'## Verificación y entrega de premios',
	'',
	'- Antes de entregar un premio, Taller Demo contacta a la persona ganadora con los datos de su compra y puede verificar su identidad y su edad mediante su documento.',
	'- Si la persona ganadora es menor de 18 años o no cumple las demás condiciones de estas bases, se anula la adjudicación y el premio se ofrece a los suplentes de ese premio, en su orden. Cada decisión queda registrada.',
	'',
	'## Generales',
	'',
	'- La modalidad y la autoridad de aplicación se completan con la aprobación legal. Mientras no haya aprobaciones registradas, la campaña no acepta participaciones.',
	'- El único medio de pago es Mercado Pago. Comprar o consultar no requiere crear una cuenta.',
	'- Las consultas y los reclamos sobre la campaña se reciben por WhatsApp, al número que figura al pie del sitio.',
	'- Las reglas esenciales quedan bloqueadas al abrir la campaña. Cualquier cambio material genera una nueva versión publicada.'
].join('\n');
export const tallerDemoPack: ClientPack = {
	slug: 'taller-demo',
	name: 'Taller Demo',
	orderPrefix: 'TD',
	// When another organization already has localhost (a database with a client loaded), Taller Demo gets demo.localhost.
	hosts: ['localhost', '127.0.0.1', 'demo.localhost'],
	settings: {
		// A made-up number (wa.me digits) and a map search of the made-up city.
		contact: { city: 'Rosario, Santa Fe', whatsapp: '5491123456789', mapsUrl: 'https://www.google.com/maps/search/?api=1&query=Rosario%2C%20Santa%20Fe' },
		social: {
			instagram: 'https://www.instagram.com/tallerdemo.ejemplo/',
			tiktok: 'https://www.tiktok.com/@tallerdemo.ejemplo',
			youtube: 'https://www.youtube.com/@TallerDemoEjemplo'
		},
		delivery: { pickupEnabled: true, shippingEnabled: true, shippingFeeMinor: 650_000, pickupNote: 'Retiro en el taller, coordinando por WhatsApp.' },
		legal: { termsVersion: legalVersion, privacyVersion: legalVersion }
	},
	theme,
	members: [
		{ email: 'owner@tallerdemo.local', role: 'org_owner' },
		{ email: 'operador@tallerdemo.local', role: 'campaign_operator' },
		{ email: 'finanzas@tallerdemo.local', role: 'finance_manager' }
	],
	blocks: [
		{
			key: 'brand',
			content: {
				logo: '/tenants/taller-demo/logo.png',
				logoAlt: 'Taller Demo',
				tagline: 'Taller de motos de demostración.'
			}
		},
		{
			key: 'home',
			content: {
				heroStyle: 'garage',
				processStyle: 'pistons',
				heroTitle: 'Un taller de motos de ejemplo',
				heroLead: 'Service, repuestos y cursos: así se ve el sitio de un comercio en la plataforma, con datos inventados.',
				heroImage: '/tenants/taller-demo/taller.jpg',
				heroImageAlt: 'Ilustración de una moto sobre un elevador en un taller',
				servicesTitle: 'Qué hacemos',
				services: [
					{ title: 'Service', body: 'Mantenimiento programado, cambio de aceite y revisión general.' },
					{ title: 'Diagnóstico', body: 'Revisamos la moto y te contamos qué necesita antes de empezar.' },
					{ title: 'Repuestos', body: 'Piezas originales y alternativas, con la garantía de cada fabricante.' },
					{ title: 'Cursos', body: 'Guías en PDF para aprender a cuidar tu moto en casa.' }
				],
				processTitle: 'Cómo trabajamos',
				process: [
					{ title: 'Recepción', body: 'Anotamos lo que nos contás y revisamos la moto.' },
					{ title: 'Presupuesto', body: 'Te pasamos el detalle antes de tocar nada.' },
					{ title: 'Trabajo', body: 'Hacemos lo acordado y te avisamos cualquier novedad.' },
					{ title: 'Entrega', body: 'Prueba final y la moto vuelve a casa.' }
				],
				ctaTitle: 'Seguinos en redes',
				ctaBody: 'En Instagram, TikTok y YouTube mostramos trabajos del taller y novedades.'
			}
		},
		{ key: 'gallery', content: gallery },
		{ key: 'legal.terms', content: legal.terms },
		{ key: 'legal.privacy', content: legal.privacy }
	],
	products: [
		{
			slug: 'manual-tecnico',
			name: 'Manual técnico Taller Demo',
			description: 'Guía en PDF de mantenimiento preventivo: lubricación, transmisión, frenos y puesta a punto, con checklists para usar en el taller de casa.',
			kind: 'digital',
			priceMinor: 5_000_000,
			sku: 'MG-MANUAL-PDF',
			imageUrl: '/tenants/taller-demo/manual-tecnico.webp',
			asset: true
		},
		{
			slug: 'checklist-digital',
			name: 'Checklist de viaje',
			description: 'Planilla imprimible para revisar la moto antes de salir a la ruta.',
			kind: 'digital',
			priceMinor: 1_500_000,
			sku: 'MG-CHECKLIST',
			imageUrl: '/tenants/taller-demo/checklist-viaje.webp',
			asset: true
		},
		{
			slug: 'calcomania',
			name: 'Calcomanía Taller Demo',
			description: 'Calcomanía de vinilo con el logo del taller. 10 cm, resistente al agua y al sol.',
			kind: 'physical',
			priceMinor: 700_000,
			sku: 'MG-STICKER',
			imageUrl: '/tenants/taller-demo/calcomania.jpg',
			stock: 200
		},
		{
			slug: 'remera',
			name: 'Remera Taller Demo',
			description: 'Remera negra de algodón con el logo del taller estampado en el pecho.',
			kind: 'physical',
			priceMinor: 4_500_000,
			sku: 'MG-REMERA-S',
			imageUrl: '/tenants/taller-demo/remera.jpg',
			variants: ['S', 'M', 'L', 'XL', 'XXL'].map((size) => ({ sku: `MG-REMERA-${size}`, name: `Talle ${size}`, stock: 10 }))
		}
	],
	// Every product suggests the other three, so the cart always offers what is missing.
	pitches: {
		'manual-tecnico': 'Despieces, torques y mantenimiento en PDF.',
		'checklist-digital': 'Ideal para acompañar el manual.',
		calcomania: 'Para el casco, la caja de herramientas o el tanque.',
		remera: 'Negra, con el logo del taller. Elegí tu talle.'
	},
	siteFaqs: [
		{ question: '¿Hacen envíos?', answer: 'Sí, los productos físicos se envían a todo el país o se retiran en el taller.' },
		{
			question: '¿Cómo y cuándo recibo los cursos en PDF y mis números?',
			answer:
				'Apenas Mercado Pago aprueba el pago te enviamos un email con el comprobante, los enlaces para descargar tus cursos en PDF y tus números para el sorteo. Si no lo ves, revisá spam o promociones. También podés consultar tu compra en «Mis compras» con tu documento.'
		},
		{
			question: '¿Cómo y cuándo se realiza el sorteo?',
			answer:
				'El sorteo se hace en la fecha publicada en la campaña y se transmite en vivo por nuestro Instagram y nuestro canal de YouTube. Los premios salen de los 20 números del extracto oficial de la Quiniela, como explican las bases de cada campaña. Si un premio no tiene cupón ganador, la campaña se reabre y una próxima jugada lo decide.'
		},
		{
			question: '¿Quién paga los gastos de transferencia y flete del premio?',
			answer: 'Depende de cada campaña: lo indican sus bases y las condiciones de cada premio.'
		}
	],
	campaign: {
		slug: 'tornado-300',
		title: 'Honda Tornado 300 0 km',
		subtitle: 'Campaña de demostración',
		summary:
			'Así se ve una campaña en la plataforma: premios, fechas, reglas y transparencia en un solo lugar. Esta campaña es una demostración y no acepta participaciones.',
		timezone: 'America/Argentina/Buenos_Aires',
		opensAt: '2026-10-20T12:00:00-03:00',
		closesAt: '2026-11-28T20:00:00-03:00',
		drawAt: '2026-11-28T22:00:00-03:00',
		isDemo: true,
		seo: { title: 'Honda Tornado 300 0 km · Taller Demo', description: 'Campaña de demostración de Taller Demo.' },
		rulesMarkdown: rules,
		eligibility: { minAge: 18, residency: 'República Argentina', excluded: ['Personal de Taller Demo y familiares directos'] },
		chancesPerUnit,
		// Credits in apps/web/static/tenants/taller-demo/premios/CREDITS.md. Who pays the vehicle's delivery and
		// transfer is a condition of this campaign, not of the organization.
		prizes: [
			{
				kind: 'vehicle',
				title: 'Honda Tornado 300 0 km',
				description: 'La entrega y los gastos de patentamiento y transferencia están a cargo del ganador, según bases.',
				conditions: 'El ganador se hace cargo de la entrega del vehículo y de los gastos de patentamiento y transferencia.',
				declaredValueMinor: 850_000_000,
				quantity: 1,
				alternatesCount: 2,
				mechanism: 'quiniela',
				imageUrl: '/tenants/taller-demo/premios/moto.jpg'
			},
			{ kind: 'cash', title: '$100.000 en efectivo', declaredValueMinor: 10_000_000, quantity: 5, alternatesCount: 1, mechanism: 'quiniela', imageUrl: '/tenants/taller-demo/premios/efectivo.jpg' },
			{ kind: 'product', title: 'Kit de indumentaria Taller Demo', description: 'Remera, gorra y calcomanías.', declaredValueMinor: 6_000_000, quantity: 2, alternatesCount: 1, mechanism: 'quiniela', imageUrl: '/tenants/taller-demo/premios/kit.jpg' }
		],
		faqs: [
			{ question: '¿Necesito crear una cuenta para comprar?', answer: 'No. Comprás con tu DNI y tu email, y recibís el comprobante y el acceso a tus archivos por correo.' },
			{ question: '¿Cómo consulto mis compras?', answer: 'En Consultar ingresás tu DNI y te enviamos un código de un solo uso al email de tu compra. Nadie más puede ver tus datos.' },
			{ question: '¿Qué significa la huella SHA-256?', answer: 'Al cierre publicamos la lista completa de participaciones sin datos personales y su huella. Cualquiera puede recalcularla y comprobar que la lista no cambió después.' },
			{
				question: '¿Quién paga la entrega y la transferencia de la moto?',
				answer: 'En esta campaña, el ganador: la entrega del vehículo y los gastos de patentamiento y transferencia están a su cargo, como dicen las bases.'
			}
		]
	}
};
