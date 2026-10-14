import { describe, expect, it } from 'vitest';
import { parseOpsEvent } from '../src';

const organizationId = '0b6a8f2e-2f7c-4c56-9a51-2f8f7e1d3a10';

describe('ops event notifications', () => {
	it('accepts the payload written by the database trigger', () => {
		const payload = JSON.stringify({ organizationId, sequence: 7, kind: 'order.updated', subjectId: null });
		expect(parseOpsEvent(payload)).toEqual({ organizationId, sequence: 7, kind: 'order.updated', subjectId: null });
	});

	it('drops anything unexpected instead of forwarding it', () => {
		expect(parseOpsEvent('not json')).toBeNull();
		expect(parseOpsEvent(JSON.stringify({ organizationId, sequence: 7, kind: 'order.deleted', subjectId: null }))).toBeNull();
		expect(parseOpsEvent(JSON.stringify({ organizationId: 'x', sequence: 7, kind: 'order.updated', subjectId: null }))).toBeNull();
		expect(parseOpsEvent(JSON.stringify({ organizationId, sequence: 0, kind: 'order.updated', subjectId: null }))).toBeNull();
		expect(parseOpsEvent(JSON.stringify({ organizationId, sequence: 7, kind: 'order.updated', subjectId: 'juana@example.com' }))).toBeNull();
	});
});
