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
	'audit.view',
	/** Payments, fees, settlements and reconciliation results. */
	'finance.view',
	/** Run reconciliation, upload settlement reports and resolve differences. */
	'finance.reconcile'
] as const;
export type Permission = (typeof permissions)[number];

const grants: Record<ActingRole, readonly Permission[]> = {
	platform_superadmin: permissions,
	// The owner consults finances (PRD §4); reconciling is the finance manager's job.
	org_owner: permissions.filter((permission) => permission !== 'finance.reconcile'),
	org_admin: ['dashboard.view', 'orders.view', 'orders.pii', 'campaigns.view', 'campaigns.manage', 'campaigns.operate', 'catalog.manage', 'cms.manage'],
	finance_manager: ['dashboard.view', 'orders.view', 'orders.pii', 'campaigns.view', 'audit.view', 'finance.view', 'finance.reconcile'],
	campaign_operator: ['dashboard.view', 'orders.view', 'campaigns.view', 'campaigns.operate'],
	auditor: ['dashboard.view', 'orders.view', 'campaigns.view', 'audit.view', 'finance.view'],
	support_agent: ['orders.view', 'campaigns.view']
};

export function can(role: ActingRole, permission: Permission): boolean {
	return grants[role].includes(permission);
}

export function permissionsFor(role: ActingRole): readonly Permission[] {
	return grants[role];
}
