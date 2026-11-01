// npm run db:migrate: upgrade the configured database without starting services.
import { Database } from 'sqlex';
import { loadConfig } from './core/config';
import { migrateDatabase } from './core/migrate';

async function main() {
  const db = new Database(loadConfig().database);
  try {
    await migrateDatabase(db);
    console.log('Database migrations applied; existing crawl data retained.');
  } finally {
    await db.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
