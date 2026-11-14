import { UrlStatus } from '../src/core/models';
import { beat, CrawlRunning, endRun, openRun, reapRuns } from '../src/core/runs';
import { TestDatabase } from './support/domain';

const db = new TestDatabase({
  dialect: 'postgres',
  connection: {
    host: '127.0.0.1',
    port: 5434,
    user: 'admin',
    password: 'secret',
    database: 'jscrawl_test',
  },
});

const run = (id: number) =>
  db.query<any[]>('select status, exit_code from crawler_run where id = ?', id).then(([r]) => r);
const urls = () =>
  db.query<{ url: string; status: number; claimed_run_id: number | null }[]>(
    'select url, status, claimed_run_id::int as claimed_run_id from url order by url',
  );

beforeAll(() => db.buildSchema());
afterAll(() => db.end());
beforeEach(async () => {
  await db.query('truncate crawler_run, url, site, crawler cascade');
  const crawler = db.table('crawler').append({ name: 'runs' });
  const site = db.table('site').append({ name: 'runs', crawler });
  for (const hash of ['a', 'b', 'c'])
    db.table('url').append({
      site,
      url: `https://runs.test/${hash}`,
      hash,
      type: 'page',
    });
  await db.flush();
  db.clear();
  await db.init('runs');
});

test("a crawl's claims name its run, and its busy urls are released when it ends, once", async () => {
  db.runId = await openRun(db, {
    siteId: db.site.id,
    kind: 'crawl',
    pid: process.pid,
  });
  const other = await openRun(db, { siteId: db.site.id, kind: 'oneshot' });
  const a = await db.claimUrl();
  const b = await db.clone().claimUrl();
  await db.table('url').update({ status: UrlStatus.Done }, { id: b!.id });
  const c = (
    await db.query<{ url: string }[]>(
      'update url set status = 1, claimed_run_id = ? where status = 0 returning url',
      other,
    )
  )[0];
  expect(new Set([a!.url, b!.url, c.url]).size).toBe(3);

  await endRun(db, db.runId, 'stopped', 0);
  await endRun(db, db.runId, 'crashed', 1);
  expect(await run(db.runId)).toEqual({ status: 'stopped', exit_code: 0 });
  // its busy url is idle again; the url it finished and another run's claim are untouched
  const after = new Map((await urls()).map((url) => [url.url, [url.status, url.claimed_run_id]]));
  expect([after.get(a!.url), after.get(b!.url), after.get(c.url)]).toEqual([
    [UrlStatus.Idle, null],
    [UrlStatus.Done, db.runId],
    [UrlStatus.Busy, other],
  ]);
});

test('a site has one live crawl; one that stopped beating is reaped, its urls released, and no longer holds the site', async () => {
  db.runId = await openRun(db, {
    siteId: db.site.id,
    kind: 'crawl',
    pid: process.pid,
  });
  await expect(openRun(db, { siteId: db.site.id, kind: 'crawl' })).rejects.toBeInstanceOf(
    CrawlRunning,
  );
  await db.claimUrl();
  expect(await beat(db, [db.runId])).toEqual([db.runId]);

  await db.query(
    "update crawler_run set heartbeat_at = now() - interval '61 seconds' where id = ?",
    db.runId,
  );
  const next = await openRun(db, { siteId: db.site.id, kind: 'crawl' });
  expect(await run(db.runId)).toMatchObject({ status: 'interrupted' });
  expect((await urls()).filter((url) => url.status === UrlStatus.Busy)).toEqual([]);
  // the reaped run's process learns it is over when it beats
  expect(await beat(db, [db.runId, next])).toEqual([next]);
  expect(await reapRuns(db)).toEqual([]);
});
