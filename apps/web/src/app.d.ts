import type { LegalDocumentData } from '#lib/components/legal/LegalDocument.svelte';
import type { SiteData } from '#lib/server/types.js';

declare global {
	namespace App {
		interface Error {
			code?: string;
		}
		interface Locals {
			site: SiteData | null;
			mode: 'dark' | 'light';
		}
		/** Shallow-routing state: a legal document opened in a modal over the page (S4). */
		interface PageState {
			legal?: LegalDocumentData;
		}
	}
}

export {};
