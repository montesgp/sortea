<script lang="ts">
	/**
	 * A secret field with an eye that shows and hides what is typed. The toggle needs
	 * JavaScript; without it the field stays masked and still works as a plain field.
	 */
	let {
		id,
		name,
		label,
		autocomplete,
		required = false,
		minlength,
		maxlength,
		describedby
	}: {
		id: string;
		name: string;
		/**
		 * The field's visible label, used in the eye's tooltip. The eye's accessible name stays "Mostrar":
		 * a name that repeats the label would match the field's own label too.
		 */
		label: string;
		autocomplete: 'current-password' | 'new-password' | 'off';
		required?: boolean;
		minlength?: number;
		maxlength?: number;
		describedby?: string;
	} = $props();

	let enhanced = $state(false);
	let visible = $state(false);
	$effect(() => {
		enhanced = true;
	});
	const subject = $derived(label.toLowerCase());
</script>

<div class="secret">
	<input
		{id}
		{name}
		type={visible ? 'text' : 'password'}
		{autocomplete}
		{required}
		{minlength}
		{maxlength}
		aria-describedby={describedby}
		spellcheck="false"
		autocapitalize="off"
	/>
	{#if enhanced}
		<button
			type="button"
			class="eye"
			aria-label="Mostrar"
			aria-controls={id}
			aria-pressed={visible}
			title={visible ? `Ocultar ${subject}` : `Mostrar ${subject}`}
			onclick={() => (visible = !visible)}
		>
			{#if visible}
				<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 3l18 18M10.6 10.6a2 2 0 0 0 2.8 2.8M9.9 5.1A9.8 9.8 0 0 1 12 5c5 0 8.5 4.2 9.5 7-.4 1.1-1.2 2.5-2.4 3.8M6.1 6.1C4.3 7.4 3 9.3 2.5 12c1 2.8 4.5 7 9.5 7 1.7 0 3.2-.5 4.5-1.2" /></svg>
			{:else}
				<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2.5 12C3.5 9.2 7 5 12 5s8.5 4.2 9.5 7c-1 2.8-4.5 7-9.5 7s-8.5-4.2-9.5-7z" /><circle cx="12" cy="12" r="3" /></svg>
			{/if}
		</button>
	{/if}
</div>

<style>
	.secret {
		position: relative;
	}

	.secret input {
		width: 100%;
		padding-right: 3.25rem;
	}

	.eye {
		position: absolute;
		inset: 0 0 0 auto;
		display: grid;
		place-items: center;
		width: 3rem;
		color: var(--muted);
		background: transparent;
		border: 0;
		border-radius: var(--radius-sm);
		cursor: pointer;
	}

	.eye:hover,
	.eye[aria-pressed='true'] {
		color: var(--text);
	}

	.eye svg {
		width: 22px;
		height: 22px;
		fill: none;
		stroke: currentColor;
		stroke-width: 1.8;
		stroke-linecap: round;
		stroke-linejoin: round;
	}
</style>
