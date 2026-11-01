import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Database } from 'sqlex';
import { BLOCKED_EXIT_CODE } from '../src/core/models';
import { Supervisor, SupervisorError } from '../src/core/supervisor';

const db = new Database({
  dialect: 'postgres',
  connection: { host: '127.0.0.1', port: 5434, user: 'admin', password: 'secret', database: 'jscrawl_test' },
});
const logDir = mkdtempSync(join(tmpdir(), 'jscrawl-sup-'));

// A stand-in crawler: announces itself, logs the graceful stop, exits 0 on SIGTERM.
const SLEEPER = `process.stdout.write('child up\\n');
process.on('SIGTERM', () => { process.stdout.write('bye\\n'); process.exit(0); });
setInterval(() => {}, 1000);`;

const supervisor = new Supervisor(db, {
  cwd: process.cwd(),
  logDir,
  crawlCommand: () => ['node', '-e', SLEEPER],
  oneshotCommand: () => ['node', '-e', SLEEPER],
});

let siteId: number;
let urlId: number;

beforeAll(() => supervisor.init());
afterAll(async () => {
  await supervisor.shutdown();
  await db.end();
  rmSync(logDir, { recursive: true, force: true });
});
beforeEach(async () => {
  await supervisor.shutdown();
  await db.query('truncate crawler_run, url, site, crawler cascade');
  await db.query("insert into crawler (name) values ('sup')");
  await db.query("insert into site (name, crawler_id) select 'sup', id from crawler where name = 'sup'");
  [{ id: siteId }] = await db.query<any[]>("select id from site where name = 'sup'");
  [{ id: urlId }] = await db.query<any[]>(
    "insert into url (site_id, type, url, hash, status) values (?, 'product', 'https://sup.test/p', 'suphash', 2) returning id",
    siteId
  );
});

const waitFor = async (check: () => Promise<boolean>, what: string, ms = 4000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for ${what}`);
};

const runRow = (id: number) => db.query<any[]>('select * from crawler_run where id = ?', id).then(([r]) => r);

/** The child needs a moment to boot and install its SIGTERM handler. */
const childUp = (runId: number) =>
  waitFor(async () => (await supervisor.log(runId, 0)).text.includes('child up'), `run ${runId} to boot`);

test('start tracks the child in crawler_run; stop stops it gracefully and keeps its log', async () => {
  const runId = await supervisor.start(siteId);
  const running = await runRow(runId);
  expect(running.status).toBe('running');
  expect(running.pid).not.toBeNull();
  expect(running.kind).toBe('crawl');
  const [status] = (await supervisor.status()).filter((s) => s.siteId === siteId);
  expect(status).toMatchObject({ siteName: 'sup', running: true, runId });

  await expect(supervisor.start(siteId)).rejects.toBeInstanceOf(SupervisorError);

  await childUp(runId);
  await supervisor.stop(siteId);
  await waitFor(async () => (await runRow(runId)).status !== 'running', 'the run to stop');
  const stopped = await runRow(runId);
  expect([stopped.status, stopped.exit_code]).toEqual(['stopped', 0]);
  expect(stopped.stopped_at).not.toBeNull();

  const log = await supervisor.log(runId, 0);
  expect(log.text).toContain('child up');
  expect(log.text).toContain('bye');
  expect(log.running).toBe(false);
  // incremental reads resume from an offset
  expect(await supervisor.log(runId, log.offset)).toMatchObject({ text: '' });
});

test('restart replaces a running crawl; stop without one is a conflict', async () => {
  await expect(supervisor.stop(siteId)).rejects.toBeInstanceOf(SupervisorError);
  const first = await supervisor.start(siteId);
  await childUp(first);
  const second = await supervisor.restart(siteId);
  expect(second).not.toBe(first);
  await waitFor(async () => (await runRow(first)).status === 'stopped', 'the first run to stop');
  await childUp(second);
  expect((await supervisor.status()).find((s) => s.siteId === siteId)).toMatchObject({ running: true, runId: second });
  await supervisor.stop(siteId);
});

test('a crawl asked to stop, or ended by Ctrl+C, is stopped; one the site refused is blocked; one that fails on its own crashed', async () => {
  // stop returns once the run is recorded, so a shutdown cannot exit first
  const graceful = await supervisor.start(siteId);
  await childUp(graceful);
  await supervisor.stop(siteId);
  expect(await runRow(graceful)).toMatchObject({ status: 'stopped', exit_code: 0 });

  // asked to stop, but exits non-zero (or is killed after the grace period)
  const stubborn = new Supervisor(db, {
    cwd: process.cwd(),
    logDir,
    crawlCommand: () => ['node', '-e', `process.stdout.write('child up\\n'); process.on('SIGTERM', () => process.exit(3)); setInterval(() => {}, 1000);`],
  });
  const asked = await stubborn.start(siteId);
  await waitFor(async () => (await stubborn.log(asked, 0)).text.includes('child up'), 'the child to boot');
  await stubborn.shutdown();
  expect(await runRow(asked)).toMatchObject({ status: 'stopped', exit_code: 3 });

  // Ctrl+C in the terminal signals the child directly
  const interrupted = await supervisor.start(siteId);
  await childUp(interrupted);
  process.kill((await runRow(interrupted)).pid, 'SIGINT');
  await waitFor(async () => (await runRow(interrupted)).status !== 'running', 'the run to end');
  expect(await runRow(interrupted)).toMatchObject({ status: 'stopped' });

  const failing = new Supervisor(db, { cwd: process.cwd(), logDir, crawlCommand: () => ['node', '-e', 'process.exit(1)'] });
  const failed = await failing.start(siteId);
  await waitFor(async () => (await runRow(failed)).status !== 'running', 'the run to end');
  expect(await runRow(failed)).toMatchObject({ status: 'crashed', exit_code: 1 });

  const refused = new Supervisor(db, { cwd: process.cwd(), logDir, crawlCommand: () => ['node', '-e', `process.exit(${BLOCKED_EXIT_CODE})`] });
  const blocked = await refused.start(siteId);
  await waitFor(async () => (await runRow(blocked)).status !== 'running', 'the run to end');
  expect(await runRow(blocked)).toMatchObject({ status: 'blocked', exit_code: BLOCKED_EXIT_CODE });
});

test('init marks orphaned running rows from a dead server as interrupted', async () => {
  const [orphan] = await db.query<{ id: number }[]>(
    "insert into crawler_run (site_id, pid, status) values (?, 999999, 'running') returning id",
    siteId
  );
  await supervisor.init();
  expect(await db.query("select 1 from crawler_run where status = 'running'")).toEqual([]);
  expect(await runRow(orphan.id)).toMatchObject({ status: 'interrupted' });
});

test('rescrape queues by idling the url, or spawns a one-shot run unless a crawl is running', async () => {
  expect(await supervisor.rescrape(urlId, 'queue')).toEqual({ queued: true });
  expect((await db.query<any[]>('select status from url where id = ?', urlId))[0].status).toBe(0);

  const crawl = await supervisor.start(siteId);
  await childUp(crawl);
  const conflict = await supervisor.rescrape(urlId, 'oneshot').catch((err) => err);
  expect(conflict).toBeInstanceOf(SupervisorError);
  expect(conflict.status).toBe(409);
  await supervisor.stop(siteId);
  await waitFor(async () => (await runRow(crawl)).status === 'stopped', 'the crawl to stop');

  const { runId } = await supervisor.rescrape(urlId, 'oneshot');
  expect(await runRow(runId!)).toMatchObject({ kind: 'oneshot', status: 'running' });
  await childUp(runId!);
  await supervisor.shutdown();
  await waitFor(async () => (await runRow(runId!)).status === 'stopped', 'the one-shot to stop');
});

test("a site's last crawl ignores one-shot re-scrapes", async () => {
  const crawl = await supervisor.start(siteId);
  await childUp(crawl);
  await supervisor.stop(siteId);
  await waitFor(async () => (await runRow(crawl)).status === 'stopped', 'the crawl to stop');
  await db.query("update crawler_run set status = 'crashed' where id = ?", crawl);
  const { runId } = await supervisor.rescrape(urlId, 'oneshot');
  await childUp(runId!);

  const [site] = await supervisor.status();
  expect([site.runId, site.lastStatus, site.running]).toEqual([crawl, 'crashed', false]);
  expect(site.stoppedAt).not.toBeNull();
  expect(await supervisor.stoppedSites()).toEqual([siteId]);
});

test('resetUrls idles done, failed and disallowed urls, sparing busy ones', async () => {
  await db.query('update url set status = -1 where id = ?', urlId);
  for (const [path, status] of [['c', 1], ['', 2], ['private', 3]] as const) {
    await db.query(
      "insert into url (site_id, type, url, hash, status) values (?, 'category', ?, ?, ?)",
      siteId, `https://sup.test/${path}`, `suphash-${path}`, status
    );
  }

  expect(await supervisor.resetUrls(siteId, { dry: true })).toEqual({ affected: 3, siteIds: [siteId] });
  expect(await supervisor.resetUrls(siteId, { dry: true, onlyFailed: true })).toEqual({ affected: 1, siteIds: [siteId] });
  expect(await supervisor.resetUrls(siteId, {})).toEqual({ affected: 3, siteIds: [siteId] });
  const statuses = await db.query<any[]>('select status from url order by id');
  expect(statuses.map((s) => s.status)).toEqual([0, 1, 0, 0]);
});

test('resetUrls of every site, and startIdle starts only the sites with idle urls and no crawl', async () => {
  await db.query("insert into crawler (name) values ('sup2')");
  const [other] = await db.query<any[]>("insert into site (name, crawler_id) select 'sup2', id from crawler where name = 'sup2' returning id");
  await db.query("insert into url (site_id, type, url, hash, status) values (?, 'product', 'https://sup2.test/p', 'sup2hash', -2)", other.id);

  const reset = await supervisor.resetUrls(null, {});
  expect([reset.affected, reset.siteIds.sort()]).toEqual([2, [siteId, Number(other.id)].sort()]);

  await db.query('update url set status = 2 where site_id = ?', other.id);
  expect(await supervisor.idleSites([siteId, Number(other.id)])).toEqual([{ siteId, urls: 1 }]);
  const started = await supervisor.startIdle([siteId, Number(other.id)]);
  expect(started.map((s) => s.siteId)).toEqual([siteId]);
  await childUp(started[0].runId);
  // a site already crawling is not started twice
  await db.query('update url set status = 0');
  expect((await supervisor.startIdle([siteId, Number(other.id)])).map((s) => s.siteId)).toEqual([Number(other.id)]);
});

test('a site with a verdict awaiting review is on hold until a person settles it', async () => {
  await db.query("update crawler set refresh_minutes = 60 where name = 'sup'");
  await db.query(
    `insert into crawler_run (site_id, kind, status, started_at, stopped_at) values (?, 'crawl', 'stopped', now() - interval '2 hours', now())`,
    siteId
  );
  await db.query('update url set status = 0');
  const [issue] = await db.query<any[]>(
    "insert into issue (url_id, kind, detail, status, verdict) values (?, 'validation', 'bad price', 'triaged', 'extractor_bug') returning id",
    urlId
  );
  expect((await supervisor.status())[0]).toMatchObject({ running: false, hold: 1 });
  await expect(supervisor.start(siteId)).rejects.toMatchObject({ status: 409, message: expect.stringContaining('on hold') });
  await expect(supervisor.restart(siteId)).rejects.toMatchObject({ status: 409 });
  expect(await supervisor.idleSites([siteId])).toEqual([]);
  expect(await supervisor.startIdle([siteId])).toEqual([]);
  expect(await supervisor.refreshDue()).toEqual([]);

  await db.query("update issue set status = 'resolved' where id = ?", issue.id);
  expect((await supervisor.status())[0]).toMatchObject({ hold: 0 });
  const [started] = await supervisor.refreshDue();
  expect(started.siteId).toBe(siteId);
  await childUp(started.runId);
});

test('stoppedSites names the sites whose last crawl ended', async () => {
  expect(await supervisor.stoppedSites()).toEqual([]);
  const runId = await supervisor.start(siteId);
  await childUp(runId);
  expect(await supervisor.stoppedSites()).toEqual([]);
  await supervisor.stop(siteId);
  await waitFor(async () => (await runRow(runId)).status === 'stopped', 'the crawl to stop');
  expect(await supervisor.stoppedSites()).toEqual([siteId]);
});

test('refreshDue re-crawls the sites whose interval has passed since their last crawl started', async () => {
  const lastCrawl = async (ago: string) => {
    await db.query('delete from crawler_run');
    await db.query(
      `insert into crawler_run (site_id, kind, status, started_at, stopped_at) values (?, 'crawl', 'stopped', now() - interval '${ago}', now())`,
      siteId
    );
  };
  // no schedule
  await lastCrawl('2 days');
  expect(await supervisor.refreshDue()).toEqual([]);

  await db.query("update crawler set refresh_minutes = 1440 where name = 'sup'");
  // never crawled: the first crawl is started by hand
  await db.query('delete from crawler_run');
  expect(await supervisor.refreshDue()).toEqual([]);
  // crawled within the interval
  await lastCrawl('2 hours');
  expect(await supervisor.refreshDue()).toEqual([]);
  // past it: the done url is reset and the crawl started
  await lastCrawl('25 hours');
  const [started] = await supervisor.refreshDue();
  expect(started.siteId).toBe(siteId);
  expect((await db.query<any[]>('select status from url where id = ?', urlId))[0].status).toBe(0);
  await childUp(started.runId);
  // the run it started counts as the last crawl
  expect(await supervisor.refreshDue()).toEqual([]);
  expect((await supervisor.status())[0]).toMatchObject({ running: true, refreshMinutes: 1440 });
});
