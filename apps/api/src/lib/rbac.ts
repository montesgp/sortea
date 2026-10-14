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
	'audit.view'
] as const;
export type Permission = (typeof permissions)[number];

const grants: Record<ActingRole, readonly Permission[]> = {
	platform_superadmin: permissions,
	org_owner: permissions,
	org_admin: ['dashboard.view', 'orders.view', 'orders.pii', 'campaigns.view', 'campaigns.manage', 'campaigns.operate'],
	finance_manager: ['dashboard.view', 'orders.view', 'orders.pii', 'campaigns.view', 'audit.view'],
	campaign_operator: ['dashboard.view', 'orders.view', 'campaigns.view', 'campaigns.operate'],
	auditor: ['dashboard.view', 'orders.view', 'campaigns.view', 'audit.view'],
	support_agent: ['orders.view', 'campaigns.view']
};

export function can(role: ActingRole, permission: Permission): boolean {
	return grants[role].includes(permission);
}

export function permissionsFor(role: ActingRole): readonly Permission[] {
	return grants[role];
}
