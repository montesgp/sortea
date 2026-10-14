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
	}
}

export {};
