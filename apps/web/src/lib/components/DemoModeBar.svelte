<script lang="ts">
	/** Shown on every public page while the API runs the local compliance demo mode (ADR 0013). */
	let { active }: { active: boolean } = $props();
</script>

{#if active}
	<aside class="demo-mode" aria-label="Modo demostración">
		<div class="container">
			<p><strong>Demostración — sin validez legal ni pagos reales.</strong> Las aprobaciones siguen pendientes y los pagos son simulados.</p>
		</div>
	</aside>
{/if}

<style>
	.demo-mode {
		background: repeating-linear-gradient(-45deg, #231a00 0 14px, #3a2c00 14px 28px);
		color: #ffd75e;
		font-size: var(--step--1);
	}

	p {
		margin: 0;
		padding-block: 0.5rem;
		text-align: center;
	}
</style>
