import type { orgRoles } from '@sortea/db';

/**
 * Permissions are checked by the API on every request (PRD §4). Hiding a menu
 * in the UI is never the control.
 */
export type OrgRole = (typeof orgRoles)[number];
export type ActingRole = OrgRole | 'platform_superadmin';

export const permissions = [
	'dashboard.view',
	'orders.view',
	'orders.pii',
	'campaigns.view',
	'campaigns.manage',
	'campaigns.operate',
	'campaigns.approve',
	/** Products, variants, prices and stock. */
	'catalog.manage',
	/** Public site content: copy, images, SEO, banner, legal texts and FAQs. */
	'cms.manage',
	/** Organization settings the organization runs itself, such as its contact WhatsApp number. */
	'settings.manage',
	'audit.view',
	/** Payments, fees, settlements and reconciliation results. */
	'finance.view',
	/** Run reconciliation, upload settlement reports and resolve differences. */
	'finance.reconcile',
	/**
	 * The live draw (odd/tasks/draw-room.md T4): read the draw room, record the
	 * round's Quiniela, run the in-app tiradas and look up coupons. No decisions,
	 * deliveries, results or campaign changes.
	 */
	'draws.run'
] as const;
export type Permission = (typeof permissions)[number];

const grants: Record<ActingRole, readonly Permission[]> = {
	platform_superadmin: permissions,
	// The owner consults finances (PRD §4); reconciling is the finance manager's job.
	org_owner: permissions.filter((permission) => permission !== 'finance.reconcile'),
	org_admin: ['dashboard.view', 'orders.view', 'orders.pii', 'campaigns.view', 'campaigns.manage', 'campaigns.operate', 'catalog.manage', 'cms.manage', 'settings.manage', 'draws.run'],
	finance_manager: ['dashboard.view', 'orders.view', 'orders.pii', 'campaigns.view', 'audit.view', 'finance.view', 'finance.reconcile'],
	campaign_operator: ['dashboard.view', 'orders.view', 'campaigns.view', 'campaigns.operate', 'draws.run'],
	auditor: ['dashboard.view', 'orders.view', 'campaigns.view', 'audit.view', 'finance.view'],
	support_agent: ['orders.view', 'campaigns.view'],
	// The person who runs the broadcast: the draw room and nothing of the management (S3, S4).
	draw_host: ['draws.run']
};

export function can(role: ActingRole, permission: Permission): boolean {
	return grants[role].includes(permission);
}

/** Whether the role holds at least one of the permissions, for routes several roles reach for different jobs. */
export function canAny(role: ActingRole, needed: readonly Permission[]): boolean {
	return needed.some((permission) => can(role, permission));
}

export function permissionsFor(role: ActingRole): readonly Permission[] {
	return grants[role];
}
