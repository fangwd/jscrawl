import { createServer } from 'http';
import { AddressInfo } from 'net';
import { hostname } from 'os';

import { endRun, openRun } from '../src/core/runs';
import { listRuns, runDetail, runFetches } from '../src/web/api/runs';
import { webHandler, WebDeps } from '../src/web/routes';
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

let siteId: number;
let urlIds: number[];

/** A fetch a run made, `seconds` after the first. */
const fetched = (
  run: number | null,
  url: number,
  seconds: number,
  result: { status?: number; error?: string },
) =>
  db.query(
    `insert into url_fetch (url_id, fetch_time, fetch_duration, http_status, error, content_length, run_id)
     values (?, timestamptz '2026-01-01' + ? * interval '1 second', ?, ?, ?, ?, ?)`,
    url,
    seconds,
    100 * (seconds + 1),
    result.status ?? null,
    result.error ?? null,
    result.status === 200 ? 1000 : 0,
    run,
  );

beforeAll(() => db.buildSchema());
afterAll(() => db.end());
beforeEach(async () => {
  await db.query('truncate crawler_run, url, site, crawler cascade');
  const crawler = db.table('crawler').append({ name: 'runs-api' });
  const site = db.table('site').append({ name: 'runs-api', crawler });
  for (const hash of ['a', 'b', 'c'])
    db.table('url').append({
      site,
      url: `https://runs-api.test/${hash}`,
      hash,
      type: 'page',
    });
  await db.flush();
  db.clear();
  siteId = (await db.init('runs-api')).id;
  urlIds = (await db.query<{ id: number }[]>('select id from url order by url')).map((u) =>
    Number(u.id),
  );
});

test('the runs are listed latest first with what they fetched, and filtered by status and kind as they are reported', async () => {
  const stopped = await openRun(db, { siteId, kind: 'crawl', pid: 11 });
  await fetched(stopped, urlIds[0], 0, { status: 200 });
  await fetched(stopped, urlIds[1], 1, { status: 503 });
  await fetched(stopped, urlIds[2], 2, { error: 'ETIMEDOUT' });
  await fetched(null, urlIds[0], 3, { status: 200 });
  await endRun(db, stopped, 'stopped', 0);
  const dead = await openRun(db, { siteId, kind: 'oneshot' });
  await db.query(
    "update crawler_run set heartbeat_at = now() - interval '61 seconds' where id = ?",
    dead,
  );
  const running = await openRun(db, { siteId, kind: 'oneshot', pid: 33 });

  const all = await listRuns(db, {});
  expect(all.total).toBe(3);
  expect(all.rows.map((r) => [r.id, r.kind, r.status, r.live, r.fetches, r.failed])).toEqual([
    [running, 'oneshot', 'running', true, 0, 0],
    // it stopped beating: over, though not recorded so yet
    [dead, 'oneshot', 'interrupted', false, 0, 0],
    [stopped, 'crawl', 'stopped', false, 3, 2],
  ]);
  expect(all.rows[2]).toMatchObject({
    siteId,
    siteName: 'runs-api',
    pid: 11,
    host: hostname(),
    local: true,
    exitCode: 0,
  });

  const ids = async (filter: Parameters<typeof listRuns>[1]) =>
    (await listRuns(db, filter)).rows.map((r) => r.id);
  expect(await ids({ status: 'running' })).toEqual([running]);
  expect(await ids({ status: 'interrupted' })).toEqual([dead]);
  expect(await ids({ status: 'stopped' })).toEqual([stopped]);
  expect(await ids({ kind: 'oneshot' })).toEqual([running, dead]);
  expect(await ids({ siteId: siteId + 1 })).toEqual([]);
  expect(await ids({ pageSize: 1, page: 2 })).toEqual([dead]);
});

test('a run is detailed with its fetch totals and the urls it holds, and its fetches are paged, the failed ones on request', async () => {
  const run = await openRun(db, { siteId, kind: 'crawl', pid: 11 });
  await fetched(run, urlIds[0], 0, { status: 200 });
  await fetched(run, urlIds[1], 1, { status: 404 });
  await db.query(
    'update url set status = 1, claimed_run_id = ?, claimed_at = now() where id = ?',
    run,
    urlIds[2],
  );

  const detail = await runDetail(db, run);
  expect(detail).toMatchObject({
    id: run,
    status: 'running',
    live: true,
    fetches: 2,
    failed: 1,
    fetchDuration: 150,
    bytes: 1000,
  });
  expect(detail!.holding.map((u) => [u.id, u.url, u.type])).toEqual([
    [urlIds[2], 'https://runs-api.test/c', 'page'],
  ]);
  expect(await runDetail(db, run + 1)).toBeNull();

  const fetches = await runFetches(db, run, {});
  expect(fetches.total).toBe(2);
  expect(fetches.rows.map((f) => [f.urlId, f.url, f.httpStatus, f.fetchDuration])).toEqual([
    [urlIds[1], 'https://runs-api.test/b', 404, 200],
    [urlIds[0], 'https://runs-api.test/a', 200, 100],
  ]);
  expect((await runFetches(db, run, { failed: true })).rows.map((f) => f.urlId)).toEqual([
    urlIds[1],
  ]);
});

test('the routes serve the runs, a run, its fetches, and its processes while it runs here', async () => {
  const over = await openRun(db, { siteId, kind: 'oneshot', pid: process.pid });
  await fetched(over, urlIds[0], 0, { status: 500 });
  await endRun(db, over, 'crashed', 1);
  const here = await openRun(db, { siteId, kind: 'crawl', pid: process.pid });
  const elsewhere = await openRun(db, { siteId, kind: 'oneshot', pid: 7 });
  await db.query("update crawler_run set host = 'other-host' where id = ?", elsewhere);

  const token = 'test-api-token-0123456789';
  const server = createServer(webHandler({ apiToken: token, db } as unknown as WebDeps));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const get = async (path: string) => {
    const response = await fetch(
      `http://127.0.0.1:${(server.address() as AddressInfo).port}${path}`,
      {
        headers: { authorization: `Bearer ${token}` },
      },
    );
    return { status: response.status, body: await response.json() };
  };
  try {
    const list = await get('/api/runs?status=crashed');
    expect(list.body.rows.map((r: any) => [r.id, r.fetches, r.failed])).toEqual([[over, 1, 1]]);
    expect((await get(`/api/runs/${over}`)).body).toMatchObject({
      id: over,
      status: 'crashed',
      exitCode: 1,
      holding: [],
    });
    expect(
      (await get(`/api/runs/${over}/fetches?failed=1`)).body.rows.map((f: any) => f.httpStatus),
    ).toEqual([500]);
    expect(await get('/api/runs/999999')).toEqual({
      status: 404,
      body: { error: 'No run 999999' },
    });
    expect((await get('/api/runs/abc')).status).toBe(400);

    const mine = (await get(`/api/runs/${here}/process`)).body;
    expect(mine.unavailable).toBeNull();
    expect(mine.run).toMatchObject({
      id: here,
      siteName: 'runs-api',
      pid: process.pid,
    });
    expect(mine.processes[0]).toMatchObject({ pid: process.pid, depth: 0 });
    expect((await get(`/api/runs/${over}/process`)).body).toMatchObject({
      processes: [],
      unavailable: `run ${over} is over`,
    });
    expect((await get(`/api/runs/${elsewhere}/process`)).body.unavailable).toBe(
      `run ${elsewhere} runs on other-host: its processes are listed there`,
    );
  } finally {
    server.close();
  }
});
