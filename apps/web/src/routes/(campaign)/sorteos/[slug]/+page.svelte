<script lang="ts">
	import Countdown from '#lib/components/Countdown.svelte';
	import ProductCard from '#lib/components/ProductCard.svelte';
	import VideoPlayer from '#lib/components/VideoPlayer.svelte';
	import { campaignStatusLabel, dateTime, money, prizeKindLabel } from '#lib/format.js';
	import { vacantPrizesLabel } from '#lib/quiniela.js';
	import { youtubeEmbed } from '#lib/youtube.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	const campaign = $derived(data.campaign);
	const status = $derived(campaignStatusLabel[campaign.status] ?? { label: campaign.status, tone: 'neutral' as const });
	const [mainPrize, ...otherPrizes] = $derived(campaign.prizes);
	const heroMedia = $derived(campaign.media.find((item) => item.role === 'hero'));
	const stream = $derived(youtubeEmbed(campaign.replayUrl ?? campaign.streamUrl));
	const countdown = $derived(
		campaign.status === 'published'
			? { target: campaign.opensAt, label: 'Faltan para la apertura', live: false, reached: 'La apertura es inminente' }
			: campaign.status === 'open'
				? { target: campaign.closesAt, label: 'Faltan para el cierre', live: campaign.acceptingParticipations, reached: 'Las participaciones cerraron' }
				: campaign.drawAt && new Date(campaign.drawAt) > new Date(campaign.serverTime)
					? { target: campaign.drawAt, label: 'Faltan para la transmisión', live: false, reached: undefined }
					: null
	);
	// Open, but every coupon of the pool is taken (ADR 0014 §1).
	const soldOut = $derived(campaign.acceptingParticipations && campaign.soldOut);
	const approvalLabel = { legal: 'Autorización legal', psp: 'Aprobación del medio de pago' } as const;
	const approvalState: Record<string, string> = { pending: 'Pendiente', approved: 'Aprobada', rejected: 'Rechazada' };
</script>

<svelte:head>
	<title>{campaign.seo.title ?? `${campaign.title} | ${data.site?.organization.name}`}</title>
	<meta name="description" content={campaign.seo.description ?? campaign.summary} />
	<meta property="og:title" content={campaign.title} />
	<meta property="og:description" content={campaign.summary} />
</svelte:head>

<section class="hero container">
	<div class="intro">
		<div class="chips">
			<span class="chip {status.tone}">{status.label}</span>
			{#if campaign.isDemo}<span class="chip neutral">Campaña de demostración</span>{/if}
			{#if campaign.round > 1}<span class="chip neutral">Ronda {campaign.round}</span>{/if}
		</div>
		<h1>{campaign.title}</h1>
		{#if campaign.subtitle}<p class="subtitle">{campaign.subtitle}</p>{/if}
		<p class="summary">{campaign.summary}</p>
		<!-- A vacant prize reopened the campaign for a new round (ADR 0014 §5). -->
		{#if campaign.round > 1}
			<div class="round">
				<p>
					Premios vacantes que se sortean en esta ronda: {vacantPrizesLabel(campaign.carriedOver)}. La ronda {campaign.status === 'open' ? 'cierra' : 'cerró'} el {dateTime(campaign.closesAt, campaign.timezone)}.
				</p>
				<p class="muted small">Los cupones de las rondas anteriores siguen participando.</p>
			</div>
		{/if}

		<dl class="facts">
			<div><dt>Apertura</dt><dd>{dateTime(campaign.opensAt, campaign.timezone)}</dd></div>
			<div><dt>Cierre</dt><dd>{dateTime(campaign.closesAt, campaign.timezone)}</dd></div>
			{#if campaign.drawAt}<div><dt>Transmisión del resultado</dt><dd>{dateTime(campaign.drawAt, campaign.timezone)}</dd></div>{/if}
			<div><dt>Modalidad</dt><dd>{campaign.modality ?? 'Se informa con la autorización'}</dd></div>
		</dl>

		{#if countdown}<Countdown target={countdown.target} serverTime={campaign.serverTime} label={countdown.label} live={countdown.live} reached={countdown.reached} />{/if}

		<div class="cta">
			{#if soldOut}
				<button class="button" type="button" disabled aria-describedby="why-closed">Cupones agotados</button>
			{:else if campaign.acceptingParticipations}
				<a class="button" href="#productos">Elegir producto y participar</a>
			{:else}
				<button class="button" type="button" disabled aria-describedby="why-closed">Participaciones no habilitadas</button>
			{/if}
			<a class="button secondary" href="/sorteos/{campaign.slug}/transparencia">Transparencia y bases</a>
		</div>
		{#if soldOut}
			<p id="why-closed" class="muted small">Se agotaron los cupones de esta campaña: ya no se pueden sumar chances.</p>
		{:else if !campaign.acceptingParticipations}
			<p id="why-closed" class="muted small">
				{campaign.status === 'published'
					? 'Las participaciones se habilitan solo cuando la campaña tiene todas sus aprobaciones y llega la fecha de apertura. Comprar antes no genera participaciones.'
					: 'Esta campaña no está recibiendo participaciones.'}
			</p>
		{/if}
	</div>

	<figure class="plate">
		{#if campaign.video}
			<VideoPlayer video={campaign.video} title="Video de {campaign.title}" />
		{:else if heroMedia?.kind === 'image'}
			<img src={heroMedia.url} alt={heroMedia.alt} />
		{:else}
			<!-- Honest placeholder until the real prize is photographed (DESIGN.md: authentic media only). -->
			<div class="sign" aria-hidden="true">
				<span class="kind">{mainPrize ? prizeKindLabel[mainPrize.kind] : 'Premio'}</span>
				<span class="name">{mainPrize?.title ?? campaign.title}</span>
			</div>
			<figcaption class="muted small">La foto y el video reales del premio se publican cuando la unidad esté en el taller.</figcaption>
		{/if}
	</figure>
</section>

<section class="container block" aria-labelledby="prizes-title">
	<h2 id="prizes-title">Premios</h2>
	{#if mainPrize}
		<article class="main-prize">
			<p class="muted">Premio principal</p>
			<h3>{mainPrize.title}</h3>
			{#if mainPrize.video}
				<VideoPlayer video={mainPrize.video} title="Video de {mainPrize.title}" />
			{:else if mainPrize.imageUrl}
				<img class="prize-image main" src={mainPrize.imageUrl} alt={mainPrize.title} />
			{/if}
			{#if mainPrize.description}<p>{mainPrize.description}</p>{/if}
			<p class="muted small">Valor declarado {money(mainPrize.declaredValueMinor, mainPrize.currency)}</p>
		</article>
	{/if}
	{#if otherPrizes.length}
		<ul class="prizes">
			{#each otherPrizes as prize (prize.position)}
				<li>
					<span class="qty">{prize.quantity}×</span>
					<div>
						<p class="prize-title">{prize.title}</p>
						{#if prize.description}<p class="muted small">{prize.description}</p>{/if}
						{#if prize.video}
							<div class="prize-video"><VideoPlayer video={prize.video} title="Video de {prize.title}" /></div>
						{:else if prize.imageUrl}
							<img class="prize-image" src={prize.imageUrl} alt={prize.title} loading="lazy" />
						{/if}
					</div>
					<span class="muted small">{prizeKindLabel[prize.kind]}</span>
				</li>
			{/each}
		</ul>
	{/if}
</section>

<section class="container block" aria-labelledby="compliance-title">
	<h2 id="compliance-title">Autorizaciones</h2>
	{#if campaign.compliance.demo}
		<p class="muted">Modo demostración: esta campaña se puede probar con pagos simulados aunque las aprobaciones sigan pendientes. No tiene validez legal.</p>
	{:else}
		<p class="muted">La campaña solo abre cuando estas aprobaciones están registradas con su número de expediente.</p>
	{/if}
	<ul class="approvals">
		{#each campaign.compliance.approvals as approval (approval.kind)}
			<li>
				<span>{approvalLabel[approval.kind]}</span>
				<span class="chip {approval.status === 'approved' ? 'ok' : approval.status === 'rejected' ? 'bad' : 'warn'}">{approvalState[approval.status]}</span>
				{#if approval.reference}<span class="muted small">{approval.authority}, {approval.reference}</span>{/if}
			</li>
		{/each}
	</ul>
</section>

{#if stream}
	<section class="container block" aria-labelledby="stream-title">
		<h2 id="stream-title">{campaign.replayUrl ? 'Grabación del resultado' : 'Transmisión en vivo'}</h2>
		<div class="video">
			<iframe src={stream} title="Transmisión de {campaign.title}" loading="lazy" allow="encrypted-media; picture-in-picture" allowfullscreen></iframe>
		</div>
	</section>
{/if}

<section class="container block" id="productos" aria-labelledby="products-title">
	<h2 id="products-title">Productos</h2>
	{#if soldOut}
		<p class="muted">Se agotaron los cupones: los productos que dan chances no se pueden comprar para esta campaña.</p>
	{:else if !campaign.acceptingParticipations}
		<p class="muted">Podés comprar los productos cuando quieras. Mientras la campaña no esté abierta, la compra no incluye participaciones.</p>
	{/if}
	<div class="products">
		{#each data.products as product (product.id)}
			<ProductCard {product} campaign={campaign.slug} chances={data.chances} />
		{/each}
	</div>
</section>

{#if data.rulesHtml && campaign.rules}
	<section class="container block" aria-labelledby="rules-title">
		<h2 id="rules-title">Bases y condiciones</h2>
		<p class="muted small">
			Versión {campaign.rules.version}, {campaign.rules.status === 'locked' ? `bloqueada el ${dateTime(campaign.rules.lockedAt!, campaign.timezone)}` : 'borrador sujeto a aprobación'}.
			{#if campaign.rules.contentHash}Huella <span class="hash">{campaign.rules.contentHash.slice(0, 16)}…</span>{/if}
		</p>
		<div class="prose rules">{@html data.rulesHtml}</div>
	</section>
{/if}

{#if campaign.faqs.length}
	<section class="container block" aria-labelledby="faq-title">
		<h2 id="faq-title">Preguntas frecuentes</h2>
		{#each campaign.faqs as faq (faq.question)}
			<details>
				<summary>{faq.question}</summary>
				<p>{faq.answer}</p>
			</details>
		{/each}
	</section>
{/if}

<style>
	.hero {
		display: grid;
		grid-template-columns: minmax(0, 1.2fr) minmax(0, 1fr);
		gap: clamp(2rem, 1rem + 4vw, 5rem);
		padding-top: clamp(2.5rem, 2rem + 3vw, 5rem);
		align-items: start;
	}

	.intro {
		display: grid;
		gap: 1.25rem;
		justify-items: start;
	}

	.chips {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
	}

	h1 {
		font-size: var(--step-5);
		line-height: 0.88;
		text-transform: uppercase;
	}

	.subtitle {
		font: 700 var(--step-2) / 1.1 var(--font-display);
		text-transform: uppercase;
		color: var(--accent);
	}

	.summary {
		max-width: 56ch;
		font-size: var(--step-1);
		color: var(--muted);
	}

	.round {
		display: grid;
		gap: 0.35rem;
		max-width: 56ch;
		padding: 1rem 1.25rem;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		background: var(--surface);
	}

	.facts {
		width: 100%;
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 1rem 1.5rem;
		margin: 0;
		padding: 1.25rem 0;
		border-block: 1px solid var(--border);
	}

	dt {
		font-size: var(--step--1);
		color: var(--muted);
	}

	dd {
		margin: 0.15rem 0 0;
		font-weight: 700;
	}

	.cta {
		display: flex;
		flex-wrap: wrap;
		gap: 0.75rem;
	}

	.small {
		font-size: var(--step--1);
	}

	/* The prize sign echoes the black plate with white lettering hanging in the workshop. */
	.plate {
		margin: 0;
		position: sticky;
		top: 100px;
		display: grid;
		gap: 0.75rem;
	}

	.plate img {
		width: 100%;
		border-radius: var(--radius);
	}

	.sign {
		display: grid;
		align-content: center;
		gap: 1rem;
		aspect-ratio: 4 / 5;
		padding: clamp(1.5rem, 1rem + 3vw, 3rem);
		background: #0b0c0d;
		color: #f2f0eb;
		border: 2px solid #f2f0eb;
		outline: 10px solid #0b0c0d;
		box-shadow: 0 0 0 12px color-mix(in srgb, var(--accent) 80%, transparent);
		margin: 22px;
	}

	.sign .kind {
		font: 700 var(--step-1) / 1 var(--font-display);
		color: var(--accent);
		text-transform: uppercase;
		letter-spacing: 0.2em;
	}

	.sign .name {
		font: 800 var(--step-4) / 0.9 var(--font-display);
		text-transform: uppercase;
		letter-spacing: 0.06em;
		border-block: 2px solid #f2f0eb;
		padding-block: 0.8rem;
	}

	.block {
		padding-top: clamp(3rem, 2rem + 3vw, 5rem);
		display: grid;
		gap: 1.25rem;
	}

	h2 {
		font-size: var(--step-3);
		text-transform: uppercase;
	}

	.main-prize {
		display: grid;
		gap: 0.5rem;
		padding: 1.75rem;
		border-left: 6px solid var(--accent);
		background: var(--surface);
		border-radius: var(--radius-sm);
	}

	.main-prize h3 {
		font-size: var(--step-4);
		text-transform: uppercase;
	}

	ul {
		list-style: none;
		margin: 0;
		padding: 0;
	}

	.prizes li,
	.approvals li {
		display: grid;
		grid-template-columns: auto 1fr auto;
		gap: 1rem;
		align-items: center;
		padding-block: 1rem;
		border-bottom: 1px solid var(--border);
	}

	.approvals li {
		grid-template-columns: 1fr auto;
	}

	.approvals li .small {
		grid-column: 1 / -1;
	}

	.qty {
		font: 800 var(--step-3) / 1 var(--font-display);
		color: var(--accent);
		min-width: 3.5rem;
	}

	.prize-title {
		font-weight: 700;
	}

	.prize-video {
		max-width: 480px;
		margin-top: 0.75rem;
	}

	/* Prize photos keep the 4:3 frame of the campaign block on the home and the shop. */
	.prize-image {
		display: block;
		width: 100%;
		max-width: 240px;
		aspect-ratio: 4 / 3;
		object-fit: cover;
		margin-top: 0.75rem;
		border-radius: var(--radius-sm);
		border: 1px solid var(--border);
	}

	.prize-image.main {
		max-width: 480px;
		margin-top: 0.25rem;
	}

	.video {
		aspect-ratio: 16 / 9;
		border-radius: var(--radius);
		overflow: hidden;
		background: #000;
	}

	.video iframe {
		width: 100%;
		height: 100%;
		border: 0;
	}

	.products {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
		/* Every row as tall as the tallest card, so all cards share one layout (S4). */
		grid-auto-rows: 1fr;
		gap: 1.25rem;
	}

	.rules {
		padding: 1.5rem;
		background: var(--surface);
		border-radius: var(--radius);
		border: 1px solid var(--border);
	}

	details {
		border-bottom: 1px solid var(--border);
		padding-block: 1rem;
	}

	summary {
		cursor: pointer;
		font-weight: 700;
	}

	details p {
		margin-top: 0.75rem;
		color: var(--muted);
		max-width: 68ch;
	}

	@media (max-width: 900px) {
		.hero {
			grid-template-columns: 1fr;
		}

		.plate {
			position: static;
			order: -1;
			max-width: 420px;
		}
	}
</style>
