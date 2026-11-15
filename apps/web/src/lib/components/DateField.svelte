<script lang="ts">
	import { dateFieldValue, parseDateInput } from '#lib/date-input.js';

	/**
	 * The panel's date, time and date-and-time field (draw room S1): text inputs
	 * typed as dd/mm/aaaa and hh:mm (24 h) instead of the browser's pickers, whose
	 * format follows the browser's language. A date-and-time field sends the day
	 * as `name` and the time as `timeName` (`<name>Time`); the server reads them
	 * with #lib/date-input, so the form works without JavaScript. `size` keeps a
	 * field as wide as its text where nothing stretches it (filter bars), as the
	 * pickers were; a grid row still stretches it to its track.
	 *
	 * A calendar button next to the day opens the browser's picker to choose it
	 * (owner feedback 2026-11-15b S10); the choice is written back as dd/mm/aaaa,
	 * and only the typed day is sent. The time input is wide enough for hh:mm (S12).
	 */
	let {
		id,
		name,
		kind = 'datetime',
		date = '',
		time = '',
		timeName = `${name}Time`,
		timeLabel = 'Hora',
		required = false,
		invalid = false,
		describedby
	}: {
		id: string;
		name: string;
		kind?: 'date' | 'time' | 'datetime';
		/** The day as the field shows it, dd/mm/aaaa (see `dateFieldValue`). */
		date?: string;
		/** The time as hh:mm. */
		time?: string;
		timeName?: string;
		/** The accessible name of the time input of a date-and-time field. */
		timeLabel?: string;
		required?: boolean;
		invalid?: boolean;
		describedby?: string;
	} = $props();

	let dayInput: HTMLInputElement | undefined = $state();
	let picker: HTMLInputElement | undefined = $state();
	/** The typed day as the picker's YYYY-MM-DD, so it opens on it; empty when it is not a day yet. */
	const pickerValue = (text: string) => {
		const parsed = parseDateInput(text);
		return parsed.ok && parsed.value ? parsed.value : '';
	};

	function openCalendar() {
		if (!picker || !dayInput) return;
		picker.value = pickerValue(dayInput.value);
		try {
			picker.showPicker();
		} catch {
			// Browsers without showPicker open it on focus and click.
			picker.focus();
			picker.click();
		}
	}

	function chosen() {
		if (!picker?.value || !dayInput) return;
		dayInput.value = dateFieldValue(picker.value);
		// The form sees it as typed: drafts, live checks and "changed" markers follow.
		dayInput.dispatchEvent(new Event('input', { bubbles: true }));
		dayInput.dispatchEvent(new Event('change', { bubbles: true }));
		dayInput.focus();
	}
</script>

{#snippet calendar()}
	<span class="calendar">
		<button type="button" class="calendar-button" aria-label="Elegir la fecha en el calendario" title="Elegir en el calendario" onclick={openCalendar}>
			<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 3v3M17 3v3M4 9h16M5 5h14a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z" /></svg>
		</button>
		<input bind:this={picker} class="picker" type="date" tabindex="-1" aria-hidden="true" value={pickerValue(date)} onchange={chosen} />
	</span>
{/snippet}

{#if kind === 'time'}
	<input {id} {name} class="time" type="text" inputmode="numeric" placeholder="hh:mm" maxlength="5" size="5" autocomplete="off" {required} defaultValue={time} aria-invalid={invalid} aria-describedby={describedby} />
{:else}
	<span class="date-field">
		<input bind:this={dayInput} {id} {name} class="day" type="text" inputmode="numeric" placeholder="dd/mm/aaaa" maxlength="10" size="10" autocomplete="off" {required} defaultValue={date} aria-invalid={invalid} aria-describedby={describedby} />
		{@render calendar()}
		{#if kind === 'datetime'}
			<input
				id="{id}-time"
				name={timeName}
				class="time"
				type="text"
				inputmode="numeric"
				placeholder="hh:mm"
				maxlength="5"
				size="5"
				autocomplete="off"
				{required}
				defaultValue={time}
				aria-label={timeLabel}
				aria-invalid={invalid}
				aria-describedby={describedby}
			/>
		{/if}
	</span>
{/if}

<style>
	.date-field {
		display: flex;
		gap: 0.5rem;
		align-items: stretch;
	}

	.date-field > .day {
		flex: 1 1 8ch;
		min-width: 0;
	}

	/* hh:mm whole, with the input's own padding (2026-11-15b S12). */
	.time {
		flex: 0 0 auto;
		min-width: calc(5ch + 2.25rem);
		width: calc(5ch + 2.25rem);
		font-variant-numeric: tabular-nums;
	}

	.calendar {
		position: relative;
		display: flex;
		flex: 0 0 auto;
	}

	.calendar-button {
		display: grid;
		place-items: center;
		width: 2.6rem;
		padding: 0;
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		background: var(--surface);
		color: var(--text);
		cursor: pointer;
	}

	.calendar-button:hover {
		border-color: var(--accent);
	}

	.calendar-button svg {
		width: 1.15rem;
		height: 1.15rem;
		fill: none;
		stroke: currentColor;
		stroke-width: 2;
		stroke-linecap: round;
		stroke-linejoin: round;
	}

	/* The browser's picker opens from here, under the button; it is never seen nor tabbed to. */
	.picker {
		position: absolute;
		inset: auto 0 0 auto;
		width: 1px;
		height: 1px;
		padding: 0;
		border: 0;
		opacity: 0;
		pointer-events: none;
	}
</style>
