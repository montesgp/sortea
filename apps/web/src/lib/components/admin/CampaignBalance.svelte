<script lang="ts">
	import { balanceLines, resultLabel, type CampaignBalance } from '#lib/finance.js';
	import { money } from '#lib/format.js';

	/**
	 * The campaign's balance (odd/tasks/campaign-finance.md S3, S5; ADR 0025): sales, then refunds,
	 * Mercado Pago fees, prizes and expenses by category, down to the result. It is a projection
	 * while the campaign sells and the final recount once it stopped.
	 */
	let { balance, currency }: { balance: CampaignBalance; currency: string } = $props();
	const lines = $derived(balanceLines(balance, currency));
	const loss = $derived(balance.resultMinor < 0);
</script>

<section class="panel" aria-labelledby="balance-title">
	<h2 id="balance-title">Balance de la campaña</h2>
	<p class="muted small">
		{balance.final
			? 'La campaña terminó de vender: este es el recuento final. Los gastos que se carguen después lo actualizan.'
			: 'La campaña sigue vendiendo: el resultado es una proyección con lo cobrado hasta ahora.'}
	</p>
	<table>
		<tbody>
			{#each lines as line (line.label)}
				<tr>
					<th scope="row">{line.sign === '−' ? `− ${line.label}` : line.label}</th>
					<td class="num">{money(line.amountMinor, currency)}</td>
				</tr>
				{#each line.detail ?? [] as item (item.label)}
					<tr class="sub">
						<th scope="row">{item.label}</th>
						<td class="num">{money(item.amountMinor, currency)}</td>
					</tr>
				{/each}
				{#if line.note}
					<tr class="note">
						<td colspan="2" class="muted small">{line.note}</td>
					</tr>
				{/if}
			{/each}
			<tr class="result" class:negative={loss}>
				<th scope="row">= {resultLabel(balance.final)}</th>
				<td class="num">{money(balance.resultMinor, currency)}
					{#if loss}<span class="loss">Pérdida</span>{/if}</td>
			</tr>
		</tbody>
	</table>
</section>

<style>
	h2 {
		font-size: var(--step-1);
		text-transform: uppercase;
		margin-bottom: 0.5rem;
	}

	.small {
		font-size: var(--step--1);
	}

	table {
		width: 100%;
		border-collapse: collapse;
		margin-top: 0.75rem;
		font-variant-numeric: tabular-nums;
	}

	th,
	td {
		padding: 0.45rem 0;
		text-align: left;
		font-weight: 400;
		border-top: 1px solid var(--border);
	}

	.num {
		text-align: right;
		white-space: nowrap;
	}

	.sub th,
	.sub td,
	.note td {
		border-top: 0;
		padding-block: 0 0.35rem;
		font-size: var(--step--1);
	}

	.sub th {
		padding-left: 1.25rem;
		color: var(--muted);
	}

	.sub td {
		color: var(--muted);
	}

	.result th,
	.result td {
		border-top: 2px solid var(--text);
		padding-top: 0.6rem;
		font-weight: 800;
		font-size: var(--step-0);
	}

	.result td {
		font-size: var(--step-1);
	}

	.result.negative td {
		color: var(--danger);
	}

	.loss {
		font-size: var(--step--1);
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}
</style>
