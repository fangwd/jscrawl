// A deployment's `src/migrate.ts`: `db:migrate` upgrades the configured database
// without starting services; with --schema (`db:schema`) it loads the schema files
// (the core's, then the domain's) into an empty one, dropping what is there.
import { Database } from 'sqlex';
import { loadConfig } from '../core/config';
import { loadSchema, migrateDatabase } from '../core/migrate';

export async function runMigrate(): Promise<void> {
  const db = new Database(loadConfig().database);
  try {
    if (process.argv.includes('--schema')) {
      await loadSchema(db);
      console.log('Schema loaded: the database is empty.');
    } else {
      await migrateDatabase(db);
      console.log('Database migrations applied; existing crawl data retained.');
    }
  } finally {
    await db.end();
  }
}
