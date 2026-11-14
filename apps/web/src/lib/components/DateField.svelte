<script lang="ts">
	/**
	 * The panel's date, time and date-and-time field (draw room S1): text inputs
	 * typed as dd/mm/aaaa and hh:mm (24 h) instead of the browser's pickers, whose
	 * format follows the browser's language. A date-and-time field sends the day
	 * as `name` and the time as `timeName` (`<name>Time`); the server reads them
	 * with #lib/date-input, so the form works without JavaScript. `size` keeps a
	 * field as wide as its text where nothing stretches it (filter bars), as the
	 * pickers were; a grid row still stretches it to its track.
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
</script>

{#if kind === 'time'}
	<input {id} {name} type="text" inputmode="numeric" placeholder="hh:mm" maxlength="5" size="5" autocomplete="off" {required} defaultValue={time} aria-invalid={invalid} aria-describedby={describedby} />
{:else}
	<span class="date-field">
		<input {id} {name} type="text" inputmode="numeric" placeholder="dd/mm/aaaa" maxlength="10" size="10" autocomplete="off" {required} defaultValue={date} aria-invalid={invalid} aria-describedby={describedby} />
		{#if kind === 'datetime'}
			<input
				id="{id}-time"
				name={timeName}
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
	}

	.date-field > input {
		flex: 1 1 8ch;
		min-width: 0;
	}

	.date-field > input + input {
		flex: 0 1 7ch;
	}
</style>
