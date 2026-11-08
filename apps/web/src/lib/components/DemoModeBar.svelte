<script lang="ts">
	import { page } from '$app/state';
	import type { SiteData } from '#lib/server/types.js';

	/** Shown on every public page while the API's compliance demo mode can waive approvals (ADR 0013). */
	let { active }: { active: boolean } = $props();
	const payments = $derived((page.data as { site?: SiteData }).site?.demoPayments === 'mercadopago_test' ? 'se usan pagos de prueba de Mercado Pago' : 'los pagos son simulados');
</script>

{#if active}
	<aside class="demo-mode" aria-label="Modo demostración">
		<div class="container">
			<p><strong>Demostración — sin validez legal ni pagos reales.</strong> Las aprobaciones siguen pendientes y {payments}.</p>
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
