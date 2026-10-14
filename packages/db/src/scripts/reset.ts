import postgres from 'postgres';
import { assertLocalDatabase, databaseUrl } from './env';

const url = databaseUrl();
assertLocalDatabase(url);
const client = postgres(url, { max: 1, onnotice: () => {} });
await client`drop schema if exists app cascade`;
await client.end();
console.log('Schema app dropped');
