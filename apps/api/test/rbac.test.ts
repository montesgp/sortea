import { orgRoles } from '@sortea/db';
import { describe, expect, it } from 'vitest';
import { can, canAny, permissions, permissionsFor, type ActingRole } from '../src/lib/rbac';

/**
 * odd/tasks/draw-room.md T4 (S3, S4): the draw host runs the live draw and
 * nothing else; the roles that already operate campaigns can open the draw room too.
 */
const roles: ActingRole[] = [...orgRoles, 'platform_superadmin'];

describe('draws.run', () => {
	it('is the only permission of the draw host', () => {
		expect(orgRoles).toContain('draw_host');
		expect(permissionsFor('draw_host')).toEqual(['draws.run']);
		for (const permission of permissions.filter((candidate) => candidate !== 'draws.run')) expect(can('draw_host', permission), permission).toBe(false);
	});

	it('is granted to the roles that open the draw room, and to no other', () => {
		const holders = roles.filter((role) => can(role, 'draws.run')).sort();
		expect(holders).toEqual(['campaign_operator', 'draw_host', 'org_admin', 'org_owner', 'platform_superadmin']);
	});

	it('leaves every other grant as it was', () => {
		expect(permissionsFor('campaign_operator')).toEqual(['dashboard.view', 'orders.view', 'campaigns.view', 'campaigns.operate', 'draws.run']);
		expect(permissionsFor('finance_manager')).toEqual(['dashboard.view', 'orders.view', 'orders.pii', 'campaigns.view', 'audit.view', 'finance.view', 'finance.reconcile']);
		expect(permissionsFor('auditor')).toEqual(['dashboard.view', 'orders.view', 'campaigns.view', 'audit.view', 'finance.view']);
		expect(permissionsFor('support_agent')).toEqual(['orders.view', 'campaigns.view']);
		expect(can('org_owner', 'finance.reconcile')).toBe(false);
		expect(permissionsFor('platform_superadmin')).toEqual(permissions);
	});
});

describe('canAny', () => {
	it('holds when the role has at least one of the permissions', () => {
		expect(canAny('draw_host', ['campaigns.operate', 'draws.run'])).toBe(true);
		expect(canAny('campaign_operator', ['campaigns.operate', 'draws.run'])).toBe(true);
		expect(canAny('draw_host', ['campaigns.operate', 'campaigns.view'])).toBe(false);
		expect(canAny('auditor', ['campaigns.operate', 'draws.run'])).toBe(false);
		expect(canAny('org_owner', [])).toBe(false);
	});
});
