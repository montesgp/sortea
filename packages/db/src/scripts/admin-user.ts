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
 *
 * `create --platform-admin` bootstraps the first platform administrator of a
 * new environment. A generated password is printed once and must be changed at
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
