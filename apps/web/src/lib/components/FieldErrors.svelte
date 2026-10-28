<script lang="ts">
	import { onMount } from 'svelte';
	import { installFieldValidation } from '#lib/field-validation.js';

	// Spanish messages under refused fields, for every form of the site (S8). Rendered once, in the root layout.
	onMount(() => installFieldValidation(document));
</script>

<style>
	:global(.field-validation-error) {
		font-size: var(--step--1);
		color: var(--danger);
	}

	/* After a checkbox or a group of radios, the message sits close to what it is about. */
	:global(label + .field-validation-error, fieldset + .field-validation-error) {
		margin-top: 0.35rem;
	}

	:global(select[aria-invalid='true'], textarea[aria-invalid='true']) {
		border-color: var(--danger);
	}
</style>
