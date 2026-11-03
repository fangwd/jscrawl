// Loads the core's schema and the test domain's into the test database, which
// the test suite assumes: DATABASE_URL, else the docker postgres on 5434.
//
//   npm run test:schema

import '../test/support/domain';
import { Database } from 'sqlex';
import { loadSchema } from '../src/core/migrate';

async function main() {
  const db = new Database({
    dialect: 'postgres',
    connection: process.env.DATABASE_URL ?? { host: '127.0.0.1', port: 5434, user: 'admin', password: 'secret', database: 'jscrawl_test' },
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
