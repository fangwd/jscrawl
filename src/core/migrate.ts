// Upgrades an existing database with the core's migrations, then the domain's.
// Migrations are additive and safe to re-run. loadSchema instead rebuilds the
// tables from schema files, replacing any existing data.
//
// schema_version records what the core and the domain last brought the
// database to. A core or domain newer than this build knows is refused: an
// older build over a migrated database would write what it no longer understands.

import { readFile } from 'fs/promises';
import { resolve } from 'path';

import { Database } from 'sqlex';

import { domain } from './domain';

/** Bumped when the core's tables change shape; the migrations bring a database up to it. */
export const CORE_SCHEMA_VERSION = 5;

const ETC = resolve(__dirname, '..', '..', 'etc');
export const CORE_SCHEMA = resolve(ETC, 'schema.sql');
const CORE_MIGRATIONS = [
  'migrate-page-snapshots.sql',
  'migrate-crawl-settings.sql',
  'migrate-snapshot-metrics.sql',
  'migrate-crawler-proxy.sql',
  'migrate-request-timeout.sql',
  'migrate-issue-problem.sql',
  'migrate-run-heartbeat.sql',
].map((name) => resolve(ETC, name));

type Migratable = Pick<Database, 'transaction'>;

/** The schema files a fresh database is loaded from, in order: the core's, then the domain's. */
export function schemaFiles(): string[] {
  return [CORE_SCHEMA, ...domain().schema.files];
}

/** Rebuilds the tables from schema files and records versions; existing data is dropped. */
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
         component text primary key, version integer not null, applied_at timestamptz not null default now())`,
    );
    const versions = await connection.query<{ component: string; version: number }[]>(
      'select component, version from schema_version where component in (?, ?)',
      'core',
      domain().name,
    );
    const current = new Map(versions.map(({ component, version }) => [component, Number(version)]));
    for (const [component, known] of [
      ['core', CORE_SCHEMA_VERSION],
      [domain().name, domain().schema.version],
    ] as const) {
      const version = current.get(component) ?? 0;
      if (version > known) {
        throw new Error(
          `The database's ${component} schema is version ${version}; this jscrawl knows version ${known}. Upgrade ${component} before running it.`,
        );
      }
    }
    for (const sql of statements) await connection.query(sql);
    await recordVersions(connection);
  });
}

async function recordVersions(connection: {
  query(sql: string, ...args: unknown[]): Promise<unknown>;
}) {
  const { name, schema } = domain();
  for (const [component, version] of [
    ['core', CORE_SCHEMA_VERSION],
    [name, schema.version],
  ] as const) {
    await connection.query(
      `insert into schema_version (component, version, applied_at) values (?, ?, now())
       on conflict (component) do update set version = excluded.version, applied_at = now()`,
      component,
      version,
    );
  }
}
