import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Database } from 'sqlex';
import { loadSchema } from '../src/core/migrate';
import { Config } from '../src/core/models';
import { removeSite, staleSites } from '../src/core/prune';

const db = new Database({
  dialect: 'postgres',
  connection: process.env.TEST_DATABASE_URL ?? {
    host: '127.0.0.1', port: 5434, user: 'admin', password: 'secret', database: 'jscrawl_test',
  },
});
afterAll(() => db.end());

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'jscrawl-prune-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** A file under the test's directory, with its parents. */
function file(path: string, content = 'x'): string {
  const full = join(root, path);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content);
  return full;
}

test('removes the sites, data and test pages of crawlers that are gone, and nothing else', async () => {
  file('crawlers/keep.ts');
  file('crawlers/busy.ts.bak');
  const keptFixture = file('crawlers/fixtures/keep/product.html');
  const goneFixture = file('crawlers/fixtures/gone/product.html');
  const config = {
    database: {},
    store: { html: join(root, 'html'), images: join(root, 'images') },
    sites: { dir: join(root, 'crawlers') },
  } as unknown as Config;

  const rollback = new Error('rollback disposable prune test schema');
  await expect(
    db.transaction(async (connection) => {
      const schema = `jscrawl_prune_test_${process.pid}_${Date.now()}`;
      await connection.query(`create schema "${schema}"`);
      await connection.query(`set local search_path to "${schema}"`);
      const within = {
        query: (sql: string, ...args: unknown[]) => connection.query(sql, ...args),
        transaction: async (callback: any) => callback(connection),
      } as unknown as Pick<Database, 'query' | 'transaction'>;
      await loadSchema(within);
      await connection.query(`
        insert into crawler (id, name) values (1, 'keep'), (2, 'gone'), (3, 'busy'), (4, 'orphan');
        insert into site (id, crawler_id, name) values (1, 1, 'keep'), (2, 2, 'gone'), (3, 3, 'busy');
        insert into url (id, site_id, type, url, hash) values
          (10, 1, 'seed', 'https://keep.test/', repeat('a', 40)),
          (20, 2, 'seed', 'https://gone.test/', repeat('b', 40)),
          (21, 2, 'image', 'https://gone.test/a.jpg', repeat('c', 40)),
          (30, 3, 'seed', 'https://busy.test/', repeat('d', 40));
        insert into page (site_id, url_id, title) values (1, 10, 'kept'), (2, 20, 'gone');
        insert into url_fetch (url_id, fetch_time) values (10, now()), (20, now());
        insert into crawler_run (site_id, status, log_path) values
          (2, 'stopped', '${file('logs/crawl-1.log')}'), (3, 'running', null);
      `);
      const keptPage = file('html/10.0');
      const gonePage = file('html/20.0');
      const goneFetches = file('html/20.0.fetches/abc');
      const goneImage = file('images/21.jpg');
      const otherImage = file('images/210.jpg');

      const stale = await staleSites(within, config);
      expect(stale).toEqual([
        { name: 'busy', siteId: 3, crawlerId: 3, urls: 1, running: true, fixtures: null },
        { name: 'gone', siteId: 2, crawlerId: 2, urls: 2, running: false, fixtures: join(root, 'crawlers/fixtures/gone') },
        { name: 'orphan', siteId: null, crawlerId: 4, urls: 0, running: false, fixtures: null },
      ]);
      await expect(removeSite(within, config, stale[0])).rejects.toThrow(/running: stop it first/);
      for (const site of stale.filter((s) => !s.running)) await removeSite(within, config, site);

      expect(await connection.query('select name from site order by name')).toEqual([{ name: 'busy' }, { name: 'keep' }]);
      expect(await connection.query('select name from crawler order by name')).toEqual([{ name: 'busy' }, { name: 'keep' }]);
      expect(await connection.query('select id::int as id from url order by id')).toEqual([{ id: 10 }, { id: 30 }]);
      expect(await connection.query('select title from page')).toEqual([{ title: 'kept' }]);
      expect(await connection.query('select url_id::int as url_id from url_fetch')).toEqual([{ url_id: 10 }]);
      expect(await connection.query('select site_id from crawler_run')).toEqual([{ site_id: 3 }]);
      for (const gone of [gonePage, goneFetches, goneImage, goneFixture, join(root, 'logs/crawl-1.log')]) expect(existsSync(gone)).toBe(false);
      for (const kept of [keptPage, otherImage, keptFixture]) expect(existsSync(kept)).toBe(true);

      expect(await staleSites(within, config)).toEqual([stale[0]]);
      throw rollback;
    })
  ).rejects.toBe(rollback);
});

test('an empty crawlers directory removes nothing', async () => {
  const config = { sites: { dir: join(root, 'crawlers') } } as unknown as Config;
  const query = jest.fn();
  await expect(staleSites({ query } as any, config)).rejects.toThrow(/No site modules .*nothing is removed/);
  expect(query).not.toHaveBeenCalled();
});
