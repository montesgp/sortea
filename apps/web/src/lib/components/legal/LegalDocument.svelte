<script lang="ts" module>
	/** The text of a legal document, shared by its page and the modal that opens it in place (S4). */
	export interface LegalDocumentData {
		title: string;
		version: string;
		kind: string;
		sections: { title: string; html: string }[] | null;
	}
</script>

<script lang="ts">
	let { doc }: { doc: LegalDocumentData } = $props();
	const data = $derived(doc);
</script>

{#if data.sections}
	<p class="muted">Versión {data.version}</p>
	{#each data.sections as section, index (index)}
		<h2>{section.title}</h2>
		{@html section.html}
	{/each}
{:else}
	<!-- The platform never writes an organization's legal text (ADR 0008): without a published document, only say so. -->
	<p class="notice">Versión {data.version}. Este documento todavía no fue publicado. Se publica el texto revisado por asesoría legal antes de habilitar ventas reales.</p>
{/if}

<style>
	.notice {
		margin-bottom: 2rem;
	}
</style>
