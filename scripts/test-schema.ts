// Replaces the target database's tables with the core and test-domain schemas.
// Uses DATABASE_URL from the shell, or the local test database on port 5434.
// Run with `npm run test:schema`; most tests use the fixed local connection.

import '../test/support/domain';
import { Database } from 'sqlex';

import { loadSchema } from '../src/core/migrate';

async function main() {
  const db = new Database({
    dialect: 'postgres',
    connection: process.env.DATABASE_URL ?? {
      host: '127.0.0.1',
      port: 5434,
      user: 'admin',
      password: 'secret',
      database: 'jscrawl_test',
    },
  });
  try {
    await loadSchema(db);
    console.log('Test schema loaded.');
  } finally {
    await db.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
