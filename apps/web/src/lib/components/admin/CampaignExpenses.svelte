<script lang="ts">
	import { expenseCategories, expenseCategoryLabels } from '@sortea/domain';
	import DateField from '#lib/components/DateField.svelte';
	import { dateFieldValue } from '#lib/date-input.js';
	import type { CampaignExpense, ExpenseInput } from '#lib/finance.js';
	import { calendarDay, money } from '#lib/format.js';
	import { moneyInputValue } from '#lib/money-input.js';

	/**
	 * The expenses charged to a campaign (odd/tasks/campaign-finance.md S2, S4, S6): everyone who
	 * sees the overview reads them; who has `finance.expenses` adds, edits and deletes them. Editing
	 * and the deletion's confirmation are links (`&editar=`, `&eliminar=`), so they work without
	 * JavaScript and a reload keeps them; every post keeps the campaign in its URL.
	 */
	let {
		campaignId,
		expenses,
		totalMinor,
		currency,
		canEdit,
		editing,
		removing,
		today,
		feedback
	}: {
		campaignId: string;
		expenses: CampaignExpense[];
		totalMinor: number;
		currency: string;
		canEdit: boolean;
		editing: string | null;
		removing: string | null;
		/** Today in the organization time zone, dd/mm/aaaa: the day a new expense starts with. */
		today: string;
		/** The result of the last post. */
		feedback: { ok: boolean; message: string; input?: ExpenseInput } | null;
	} = $props();

	const here = $derived(`?campana=${campaignId}`);
	const action = (name: string) => `${here}&/${name}`;
	// A refused post comes back with what was typed, edit or not; otherwise the link says what is edited.
	const editedId = $derived(feedback?.input ? feedback.input.id : editing);
	const edited = $derived(editedId ? expenses.find((expense) => expense.id === editedId) : undefined);
	const draft = $derived<ExpenseInput>(
		feedback?.input ??
			(edited
				? { id: edited.id, category: edited.category, detail: edited.detail, amount: moneyInputValue(edited.amountMinor), spentOn: dateFieldValue(edited.spentOn) }
				: { id: '', category: '', detail: '', amount: '', spentOn: today })
	);
	const isEdit = $derived(Boolean(draft.id));
	const toRemove = $derived(canEdit && removing ? expenses.find((expense) => expense.id === removing) : undefined);
</script>

<section class="panel" aria-labelledby="expenses-title">
	<h2 id="expenses-title">Gastos</h2>
	<p class="muted small">Lo que costó la campaña: se resta del resultado. El gasto se carga en pesos, con la fecha en que se pagó.</p>

	{#if feedback}<p class="notice {feedback.ok ? 'ok' : 'error'}" role={feedback.ok ? 'status' : 'alert'}>{feedback.message}</p>{/if}

	{#if toRemove}
		<div class="confirm" role="group" aria-labelledby="remove-title">
			<p id="remove-title"><strong>¿Eliminar el gasto «{toRemove.detail}» de {money(toRemove.amountMinor, currency)}?</strong></p>
			<p class="muted small">Se resta del balance y queda registrado en la auditoría.</p>
			<div class="actions">
				<form method="POST" action={action('deleteExpense')}>
					<input type="hidden" name="id" value={toRemove.id} />
					<button class="button small danger">Eliminar gasto</button>
				</form>
				<a class="button small secondary" href={here}>Cancelar</a>
			</div>
		</div>
	{/if}

	{#if expenses.length === 0}
		<p class="muted">Todavía no hay gastos cargados en esta campaña.</p>
	{:else}
		<div class="table-wrap">
			<table>
				<thead>
					<tr>
						<th scope="col">Fecha</th>
						<th scope="col">Categoría</th>
						<th scope="col">Detalle</th>
						<th scope="col" class="num">Monto</th>
						{#if canEdit}<th scope="col"><span class="visually-hidden">Acciones</span></th>{/if}
					</tr>
				</thead>
				<tbody>
					{#each expenses as expense (expense.id)}
						<tr class:current={expense.id === editedId}>
							<td class="day">{calendarDay(expense.spentOn)}</td>
							<td>{expenseCategoryLabels[expense.category] ?? expense.category}</td>
							<td>{expense.detail}</td>
							<td class="num">{money(expense.amountMinor, currency)}</td>
							{#if canEdit}
								<td class="row-actions">
									<a href="{here}&editar={expense.id}" aria-label="Editar {expense.detail}">Editar</a>
									<a class="remove" href="{here}&eliminar={expense.id}" aria-label="Eliminar {expense.detail}">Eliminar</a>
								</td>
							{/if}
						</tr>
					{/each}
				</tbody>
				<tfoot>
					<tr>
						<th scope="row" colspan="3">Total</th>
						<td class="num">{money(totalMinor, currency)}</td>
						{#if canEdit}<td></td>{/if}
					</tr>
				</tfoot>
			</table>
		</div>
	{/if}

	{#if canEdit}
		<form method="POST" action={action(isEdit ? 'updateExpense' : 'addExpense')} class="stack expense-form" id="expense-form">
			<h3>{isEdit ? 'Editar gasto' : 'Cargar gasto'}</h3>
			{#if isEdit}<input type="hidden" name="id" value={draft.id} />{/if}
			<div class="row">
				<div class="field">
					<label for="expense-category">Categoría</label>
					<select id="expense-category" name="category" required>
						<option value="" disabled selected={!draft.category}>Elegí una categoría</option>
						{#each expenseCategories as category (category)}
							<option value={category} selected={draft.category === category}>{expenseCategoryLabels[category]}</option>
						{/each}
					</select>
				</div>
				<div class="field">
					<label for="expense-day">Fecha</label>
					<DateField id="expense-day" name="spentOn" kind="date" required date={draft.spentOn} />
				</div>
			</div>
			<div class="row">
				<div class="field">
					<label for="expense-detail">Detalle</label>
					<input id="expense-detail" name="detail" required maxlength="200" placeholder="Hosting de noviembre" value={draft.detail} />
				</div>
				<div class="field">
					<label for="expense-amount">Monto en pesos</label>
					<input id="expense-amount" name="amount" type="text" inputmode="decimal" required autocomplete="off" placeholder="12.500,50" value={draft.amount} />
					<p class="hint">Con punto para los miles y coma para los centavos, por ejemplo 12.500 o 12500,50.</p>
				</div>
			</div>
			<div class="actions">
				<button class="button small">{isEdit ? 'Guardar cambios' : 'Cargar gasto'}</button>
				{#if isEdit}<a class="button small secondary" href={here}>Cancelar</a>{/if}
			</div>
		</form>
	{/if}
</section>

<style>
	h2 {
		font-size: var(--step-1);
		text-transform: uppercase;
		margin-bottom: 0.5rem;
	}

	h3 {
		font-size: var(--step-0);
		text-transform: uppercase;
	}

	.small {
		font-size: var(--step--1);
	}

	.panel {
		display: grid;
		gap: 0.9rem;
		align-content: start;
	}

	.table-wrap {
		overflow-x: auto;
		border: 1px solid var(--border);
		border-radius: var(--radius);
	}

	table {
		width: 100%;
		border-collapse: collapse;
		font-size: var(--step--1);
		font-variant-numeric: tabular-nums;
	}

	th,
	td {
		padding: 0.6rem 0.8rem;
		text-align: left;
		border-bottom: 1px solid var(--border);
		vertical-align: top;
	}

	thead th {
		background: var(--surface);
		font-weight: 700;
		white-space: nowrap;
	}

	tfoot th,
	tfoot td {
		font-weight: 800;
		border-bottom: 0;
	}

	tr.current td {
		background: color-mix(in srgb, var(--accent) 10%, transparent);
	}

	.num,
	.day {
		white-space: nowrap;
	}

	.num {
		text-align: right;
	}

	.row-actions {
		white-space: nowrap;
		text-align: right;
	}

	.row-actions a + a {
		margin-left: 0.9rem;
	}

	.remove {
		color: var(--danger);
	}

	.confirm {
		display: grid;
		gap: 0.5rem;
		padding: 0.9rem 1rem;
		border: 1px solid var(--border);
		border-left: 4px solid var(--danger);
		border-radius: var(--radius-sm);
	}

	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.6rem;
		align-items: center;
	}

	.button.danger {
		--button-bg: var(--danger);
		--button-fg: #fff;
	}

	.expense-form {
		display: grid;
		gap: 0.9rem;
		padding-top: 0.9rem;
		border-top: 1px solid var(--border);
	}

	.row {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
		gap: 0.9rem;
	}

	/* On a phone each expense is a block: day and amount first, then category, detail and actions. */
	@media (max-width: 600px) {
		thead {
			display: none;
		}

		tbody tr {
			display: grid;
			grid-template-columns: 1fr auto;
			gap: 0.2rem 0.75rem;
			padding: 0.7rem 0.8rem;
			border-bottom: 1px solid var(--border);
		}

		tbody td {
			padding: 0;
			border: 0;
		}

		tbody td.num {
			grid-row: 1;
			grid-column: 2;
			font-weight: 700;
		}

		tbody td:not(.day):not(.num) {
			grid-column: 1 / -1;
		}

		.row-actions {
			text-align: left;
			padding-top: 0.3rem;
		}

		tfoot tr {
			display: flex;
			justify-content: space-between;
		}

		tfoot td:empty {
			display: none;
		}
	}
</style>
