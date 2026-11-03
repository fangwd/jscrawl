// Upgrades for an existing database: the core's migrations, then the domain's,
// each additive and safe to re-run. Fresh databases are initialized from the
// schema files instead (loadSchema, or bin/start.sh piping them into psql).
//
// schema_version records what the core and the domain last brought the
// database to. A core newer than the package knows is refused: an older core
// over a migrated database would write what it no longer understands.

import { readFile } from 'fs/promises';
import { resolve } from 'path';
import { Database } from 'sqlex';
import { domain } from './domain';

/** Bumped when the core's tables change shape; the migrations bring a database up to it. */
export const CORE_SCHEMA_VERSION = 1;

const ETC = resolve(__dirname, '..', '..', 'etc');
export const CORE_SCHEMA = resolve(ETC, 'schema.sql');
const CORE_MIGRATIONS = ['migrate-page-snapshots.sql', 'migrate-crawl-settings.sql', 'migrate-snapshot-metrics.sql'].map((name) =>
  resolve(ETC, name)
);

type Migratable = Pick<Database, 'transaction'>;

/** The schema files a fresh database is loaded from, in order: the core's, then the domain's. */
export function schemaFiles(): string[] {
  return [CORE_SCHEMA, ...domain().schema.files];
}

/** Loads the schema files into an empty database and records the versions. */
export async function loadSchema(db: Migratable): Promise<void> {
  const statements = await Promise.all(schemaFiles().map((file) => readFile(file, 'utf8')));
  await db.transaction(async (connection) => {
    for (const sql of statements) await connection.query(sql);
    await recordVersions(connection);
  });
}

export async function migrateDatabase(db: Migratable): Promise<void> {
  const files = [...CORE_MIGRATIONS, ...domain().schema.migrations];
  const statements = await Promise.all(files.map((file) => readFile(file, 'utf8')));
  await db.transaction(async (connection) => {
    await connection.query("set local lock_timeout = '5s'");
    // Two servers upgrading together must not race on IF NOT EXISTS checks.
    await connection.query("select pg_advisory_xact_lock(hashtext('jscrawl schema migrations'))");
    await connection.query(
      `create table if not exists schema_version (
         component text primary key, version integer not null, applied_at timestamptz not null default now())`
    );
    const [core] = await connection.query<{ version: number }[]>("select version from schema_version where component = 'core'");
    if (core && Number(core.version) > CORE_SCHEMA_VERSION) {
      throw new Error(
        `The database's core schema is version ${core.version}; this jscrawl knows version ${CORE_SCHEMA_VERSION}. Upgrade the core before running it.`
      );
    }
    for (const sql of statements) await connection.query(sql);
    await recordVersions(connection);
  });
}

async function recordVersions(connection: { query(sql: string, ...args: unknown[]): Promise<unknown> }) {
  const { name, schema } = domain();
  for (const [component, version] of [
    ['core', CORE_SCHEMA_VERSION],
    [name, schema.version],
  ] as const) {
    await connection.query(
      `insert into schema_version (component, version, applied_at) values (?, ?, now())
       on conflict (component) do update set version = excluded.version, applied_at = now()`,
      component,
      version
    );
  }
}
