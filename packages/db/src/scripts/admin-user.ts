import { createDatabase } from '../client';
import { runAdminUserCommand } from '../admin-user-command';
import { databaseUrl } from './env';

/**
 * Back-office accounts of the database at DATABASE_URL (ADR 0020, "Recovery"):
 *
 *   pnpm admin:user create <email> [--platform-admin]
 *   pnpm admin:user reset-password <email>
 *   pnpm admin:user reset-mfa <email>
 *   pnpm admin:user disable <email>
 *   pnpm admin:user add-member <email> --org <organization slug> --role <role>
 *
 * `create --platform-admin` bootstraps the first platform administrator of a
 * new environment. `add-member` gives a person a role in an organization, for
 * instance `draw_host` (draw-room T4), creating the account when it does not
 * exist. A generated password is printed once and must be changed at
 * the first sign-in; nothing else secret is ever printed.
 */
const url = databaseUrl();
const handle = createDatabase(url, { max: 1 });
try {
	console.log(`Database: ${new URL(url).host}${new URL(url).pathname}`);
	process.exitCode = await runAdminUserCommand(handle, process.argv.slice(2), { log: (line) => console.log(line), error: (line) => console.error(line) });
} finally {
	await handle.close();
}
