// Additive upgrades for an existing domain database. Fresh databases are still
// initialized from etc/schema.sql by bin/start.sh.
import { readFile } from 'fs/promises';
import { resolve } from 'path';
import { Database } from 'sqlex';

const MIGRATIONS = ['migrate-page-snapshots.sql', 'migrate-crawl-settings.sql', 'migrate-variant-order.sql'];

export async function migrateDatabase(db: Pick<Database, 'transaction'>): Promise<void> {
  const statements = await Promise.all(MIGRATIONS.map((name) => readFile(resolve('etc', name), 'utf8')));
  await db.transaction(async (connection) => {
    await connection.query("set local lock_timeout = '5s'");
    // Two servers upgrading together must not race on IF NOT EXISTS checks.
    await connection.query("select pg_advisory_xact_lock(hashtext('jscrawl schema migrations'))");
    for (const sql of statements) await connection.query(sql);
  });
}
