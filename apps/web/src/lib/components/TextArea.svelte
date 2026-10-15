<script lang="ts">
	import { browser } from '$app/env';
	import type { HTMLTextareaAttributes } from 'svelte/elements';

	/**
	 * A textarea whose initial text is in the server HTML and survives
	 * hydration. Svelte renders `defaultValue` only for inputs on the server,
	 * and a `value` re-applied while hydrating would wipe text typed before the
	 * page finished loading. So the server emits `value` and the browser only
	 * sets `defaultValue`, which never overrides an edited field.
	 */
	let { value = '', ...rest }: Omit<HTMLTextareaAttributes, 'value' | 'defaultValue'> & { value?: string | null } = $props();
</script>

<textarea {...rest} value={browser ? undefined : (value ?? '')} defaultValue={value ?? ''}></textarea>
