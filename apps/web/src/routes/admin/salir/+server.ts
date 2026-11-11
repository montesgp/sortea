import { redirect } from '@sveltejs/kit';
import { signOut } from '#lib/server/admin-session.js';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async (event) => {
	await signOut(event);
	redirect(303, '/admin/login');
};
