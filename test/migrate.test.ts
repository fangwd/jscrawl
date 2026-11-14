import { Database } from 'sqlex';

import { migrateDatabase } from '../src/core/migrate';

const db = new Database({
  dialect: 'postgres',
  connection: process.env.MIGRATION_TEST_DATABASE_URL ?? {
    host: '127.0.0.1',
    port: 5434,
    user: 'admin',
    password: 'secret',
    database: 'jscrawl_test',
  },
});
afterAll(() => db.end());

test('upgrading retains data and settings, converts snapshots, codes issues, accepts blocked runs, ends unbeating runs, records versions and can run twice', async () => {
  const rollback = new Error('rollback disposable migration test schema');
  await expect(
    db.transaction(async (connection) => {
      const schema = `jscrawl_migration_test_${process.pid}_${Date.now()}`;
      // Keep the test isolated even when explicitly pointed at an existing database.
      await connection.query(`create schema "${schema}"`);
      await connection.query(`set local search_path to "${schema}"`);
      await connection.query(`
      create table crawler (id integer primary key, name text not null);
      create table site (id integer primary key, crawler_id integer references crawler(id), name text not null);
      create table crawler_run (id integer primary key, site_id integer references site(id), kind text not null default 'crawl',
        status text not null check (status in ('running', 'stopped', 'crashed', 'interrupted')), stopped_at timestamptz);
      create table url (id integer primary key, site_id integer references site(id), status smallint not null default 0, claimed_at timestamptz);
      create table crawl_snapshot (id integer primary key, site_id integer references site(id),
        taken_at timestamptz not null default now(), products integer not null, fields jsonb not null, pages jsonb not null);
      insert into crawler values (1, 'existing-crawler');
      insert into site values (1, 1, 'existing-site');
      insert into crawler_run (id, site_id, status) values (1, 1, 'stopped'), (2, 1, 'running');
      insert into url (id, site_id, status) values (1, 1, 1), (2, 1, 2);
      insert into crawl_snapshot (id, site_id, products, fields, pages) values (1, 1, 42, '{"description":42}', '{"done":42,"failed":0}');
      create table issue (id integer primary key, url_id integer not null, kind text not null, detail text not null,
        status text not null default 'open', verdict text, resolution text, same_as integer references issue(id), resolved_at timestamptz);
      insert into issue (id, url_id, kind, detail, status, verdict, same_as) values
        (1, 1, 'scrape_failed', 'login redirect to https://shop.test/login?next=1', 'triaged', 'blocked_by_site', null),
        (2, 2, 'scrape_failed', 'login redirect to https://shop.test/login?next=2', 'triaged', 'blocked_by_site', 1),
        (3, 3, 'scrape_failed', 'missing SKU', 'triaged', 'blocked_by_site', 1),
        (4, 4, 'scrape_failed', 'missing SKU', 'resolved', 'blocked_by_site', 1);
    `);
      // Reuse this test's connection so all DDL and sentinel data are rolled back.
      const withinTest = {
        transaction: async (callback: any) => callback(connection),
      } as Pick<Database, 'transaction'>;
      await migrateDatabase(withinTest);
      expect(
        await connection.query(
          'select name, refresh_minutes, page_snapshots, proxy_type, proxy_country, request_timeout from crawler',
        ),
      ).toEqual([
        {
          name: 'existing-crawler',
          refresh_minutes: null,
          page_snapshots: 'gzip',
          proxy_type: null,
          proxy_country: null,
          request_timeout: 30,
        },
      ]);
      for (const invalid of [
        "proxy_type = 'Residential'",
        "proxy_type = 'residential', proxy_country = 'au'",
        "proxy_type = null, proxy_country = 'AU'",
      ]) {
        await connection.query('savepoint invalid_proxy');
        await expect(connection.query(`update crawler set ${invalid}`)).rejects.toThrow(
          /check constraint/,
        );
        await connection.query('rollback to savepoint invalid_proxy');
      }
      expect(await connection.query('select name, expect from site')).toEqual([
        { name: 'existing-site', expect: null },
      ]);
      expect(await connection.query('select id, status from crawler_run order by id')).toEqual([
        { id: 1, status: 'stopped' },
        { id: 2, status: 'interrupted' },
      ]);
      // a run from before beats cannot be told alive: it is over, and its busy urls idle
      expect(
        await connection.query('select id, status, claimed_run_id from url order by id'),
      ).toEqual([
        { id: 1, status: 0, claimed_run_id: null },
        { id: 2, status: 2, claimed_run_id: null },
      ]);
      expect(
        await connection.query('select component, version from schema_version order by component'),
      ).toEqual([
        { component: 'core', version: 5 },
        { component: 'test', version: 1 },
      ]);
      // legacy issues are coded by their detail, and copies of a different problem are detached
      expect(
        await connection.query(
          'select id, problem, status, verdict, same_as from issue order by id',
        ),
      ).toEqual([
        {
          id: 1,
          problem: 'login redirect to <url>',
          status: 'triaged',
          verdict: 'blocked_by_site',
          same_as: null,
        },
        {
          id: 2,
          problem: 'login redirect to <url>',
          status: 'triaged',
          verdict: 'blocked_by_site',
          same_as: 1,
        },
        {
          id: 3,
          problem: 'missing SKU',
          status: 'open',
          verdict: null,
          same_as: null,
        },
        {
          id: 4,
          problem: 'missing SKU',
          status: 'resolved',
          verdict: 'blocked_by_site',
          same_as: null,
        },
      ]);
      // the legacy snapshot columns became one metrics document
      expect(await connection.query('select metrics, pages from crawl_snapshot')).toEqual([
        {
          metrics: { products: 42, description: 42 },
          pages: { done: 42, failed: 0 },
        },
      ]);
      await connection.query("update crawler_run set status = 'blocked' where id = 1");
      await connection.query(
        "update crawler_run set status = 'running', heartbeat_at = now() where id = 2",
      );
      await connection.query('update url set status = 1, claimed_run_id = 2 where id = 1');
      await connection.query(
        "update crawler set refresh_minutes = 1440, page_snapshots = 'off', proxy_type = 'residential', proxy_country = 'AU', request_timeout = 90",
      );
      await connection.query(`update site set expect = '{"fields":["description"]}'`);
      await connection.query(`insert into crawl_snapshot (id, site_id, metrics, pages)
      values (2, 1, '{"products":7,"price":7}', '{"done":7,"failed":1}')`);
      await migrateDatabase(withinTest);
      expect(await connection.query('select id, status from crawler_run order by id')).toEqual([
        { id: 1, status: 'blocked' },
        { id: 2, status: 'running' },
      ]);
      expect(
        await connection.query(
          'select status, claimed_run_id::int as claimed_run_id from url where id = 1',
        ),
      ).toEqual([{ status: 1, claimed_run_id: 2 }]);
      expect(
        await connection.query(
          'select refresh_minutes, page_snapshots, proxy_type, proxy_country, request_timeout from crawler',
        ),
      ).toEqual([
        {
          refresh_minutes: 1440,
          page_snapshots: 'off',
          proxy_type: 'residential',
          proxy_country: 'AU',
          request_timeout: 90,
        },
      ]);
      expect(await connection.query('select expect from site')).toEqual([
        { expect: { fields: ['description'] } },
      ]);
      expect(
        await connection.query('select metrics, pages from crawl_snapshot order by id'),
      ).toEqual([
        {
          metrics: { products: 42, description: 42 },
          pages: { done: 42, failed: 0 },
        },
        { metrics: { products: 7, price: 7 }, pages: { done: 7, failed: 1 } },
      ]);
      await connection.query('savepoint invalid_interval');
      await expect(connection.query('update crawler set refresh_minutes = 0')).rejects.toThrow(
        /check constraint/,
      );
      await connection.query('rollback to savepoint invalid_interval');
      await connection.query('savepoint invalid_status');
      await expect(connection.query("update crawler_run set status = 'unknown'")).rejects.toThrow(
        /check constraint/,
      );
      await connection.query('rollback to savepoint invalid_status');
      throw rollback;
    }),
  ).rejects.toBe(rollback);
});
