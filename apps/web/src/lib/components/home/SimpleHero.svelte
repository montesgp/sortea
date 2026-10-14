<script lang="ts">
	interface Props {
		title: string;
		lead: string;
		image: string | null;
		imageAlt: string;
		primary: { href: string; label: string };
		secondary?: { href: string; label: string };
	}

	let { title, lead, image, imageAlt, primary, secondary }: Props = $props();
</script>

<!-- Default hero for organizations without a signature treatment. -->
<section class="hero" aria-labelledby="hero-title">
	<div class="container layout" class:with-image={Boolean(image)}>
		<div>
			<h1 id="hero-title">{title}</h1>
			<p class="lead">{lead}</p>
			<div class="actions">
				<a class="button" href={primary.href}>{primary.label}</a>
				{#if secondary}<a class="button secondary" href={secondary.href}>{secondary.label}</a>{/if}
			</div>
		</div>
		{#if image}<img src={image} alt={imageAlt} />{/if}
	</div>
</section>

<style>
	.hero {
		padding-block: clamp(3rem, 2rem + 5vw, 7rem);
		background: linear-gradient(160deg, color-mix(in srgb, var(--accent) 10%, var(--bg)), var(--bg) 60%);
	}

	.layout.with-image {
		display: grid;
		grid-template-columns: 1.2fr 1fr;
		gap: 3rem;
		align-items: center;
	}

	h1 {
		font-size: var(--step-5);
		max-width: 14ch;
	}

	.lead {
		margin-top: 1.25rem;
		max-width: 52ch;
		font-size: var(--step-1);
		color: var(--muted);
	}

	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.75rem;
		margin-top: 2rem;
	}

	img {
		width: 100%;
		border-radius: var(--radius);
	}

	@media (max-width: 860px) {
		.layout.with-image {
			grid-template-columns: 1fr;
		}
	}
</style>
