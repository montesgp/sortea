// Runs the Supabase CLI with an explicit profile so a stale global
// ~/.supabase/profile from another project cannot break local development.
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const result = spawnSync('supabase', args, {
	stdio: 'inherit',
	shell: process.platform === 'win32',
	env: { ...process.env, SUPABASE_PROFILE: process.env.SUPABASE_PROFILE ?? 'supabase' }
});
process.exit(result.status ?? 1);
