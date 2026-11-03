import { Database } from 'sqlex';
import { migrateDatabase } from '../src/core/migrate';

const db = new Database({
  dialect: 'postgres',
  connection: process.env.MIGRATION_TEST_DATABASE_URL ?? {
    host: '127.0.0.1', port: 5434, user: 'admin', password: 'secret', database: 'jscrawl_test',
  },
});
afterAll(() => db.end());

test('upgrading retains data and settings, converts snapshots, accepts blocked runs, records versions and can run twice', async () => {
  const rollback = new Error('rollback disposable migration test schema');
  await expect(db.transaction(async (connection) => {
    const schema = `jscrawl_migration_test_${process.pid}_${Date.now()}`;
    // Keep the test isolated even when explicitly pointed at an existing database.
    await connection.query(`create schema "${schema}"`);
    await connection.query(`set local search_path to "${schema}"`);
    await connection.query(`
      create table crawler (id integer primary key, name text not null);
      create table site (id integer primary key, crawler_id integer references crawler(id), name text not null);
      create table crawler_run (id integer primary key, site_id integer references site(id),
        status text not null check (status in ('running', 'stopped', 'crashed', 'interrupted')));
      create table crawl_snapshot (id integer primary key, site_id integer references site(id),
        taken_at timestamptz not null default now(), products integer not null, fields jsonb not null, pages jsonb not null);
      insert into crawler values (1, 'existing-crawler');
      insert into site values (1, 1, 'existing-site');
      insert into crawler_run values (1, 1, 'stopped');
      insert into crawl_snapshot (id, site_id, products, fields, pages) values (1, 1, 42, '{"description":42}', '{"done":42,"failed":0}');
    `);
    // Reuse this test's connection so all DDL and sentinel data are rolled back.
    const withinTest = { transaction: async (callback: any) => callback(connection) } as Pick<Database, 'transaction'>;
    await migrateDatabase(withinTest);
    expect(await connection.query('select name, refresh_minutes, page_snapshots from crawler')).toEqual([
      { name: 'existing-crawler', refresh_minutes: null, page_snapshots: 'gzip' },
    ]);
    expect(await connection.query('select name, expect from site')).toEqual([{ name: 'existing-site', expect: null }]);
    expect(await connection.query('select status from crawler_run')).toEqual([{ status: 'stopped' }]);
    expect(await connection.query('select component, version from schema_version order by component')).toEqual([
      { component: 'core', version: 1 },
      { component: 'test', version: 1 },
    ]);
    // the legacy snapshot columns became one metrics document
    expect(await connection.query('select metrics, pages from crawl_snapshot')).toEqual([
      { metrics: { products: 42, description: 42 }, pages: { done: 42, failed: 0 } },
    ]);
    await connection.query("update crawler_run set status = 'blocked'");
    await connection.query("update crawler set refresh_minutes = 1440, page_snapshots = 'off'");
    await connection.query(`update site set expect = '{"fields":["description"]}'`);
    await connection.query(`insert into crawl_snapshot (id, site_id, metrics, pages)
      values (2, 1, '{"products":7,"price":7}', '{"done":7,"failed":1}')`);
    await migrateDatabase(withinTest);
    expect(await connection.query('select status from crawler_run')).toEqual([{ status: 'blocked' }]);
    expect(await connection.query('select refresh_minutes, page_snapshots from crawler')).toEqual([
      { refresh_minutes: 1440, page_snapshots: 'off' },
    ]);
    expect(await connection.query('select expect from site')).toEqual([{ expect: { fields: ['description'] } }]);
    expect(await connection.query('select metrics, pages from crawl_snapshot order by id')).toEqual([
      { metrics: { products: 42, description: 42 }, pages: { done: 42, failed: 0 } },
      { metrics: { products: 7, price: 7 }, pages: { done: 7, failed: 1 } },
    ]);
    await connection.query('savepoint invalid_interval');
    await expect(connection.query('update crawler set refresh_minutes = 0')).rejects.toThrow(/check constraint/);
    await connection.query('rollback to savepoint invalid_interval');
    await connection.query('savepoint invalid_status');
    await expect(connection.query("update crawler_run set status = 'unknown'")).rejects.toThrow(/check constraint/);
    await connection.query('rollback to savepoint invalid_status');
    throw rollback;
  })).rejects.toBe(rollback);
});
