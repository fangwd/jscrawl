import { mkdtempSync, rmSync } from 'fs';
import { createServer, Server } from 'http';
import { AddressInfo } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';
import { Database } from 'sqlex';
import { Supervisor } from '../src/core/supervisor';
import { sha1 } from '../src/core/utils';
import { DomainTool, domainTools } from '../src/mcp/tools';
import { webHandler } from '../src/web/routes';

const connection = { host: '127.0.0.1', port: 5434, user: 'admin', password: 'secret', database: 'jscrawl_test' };
const db = new Database({ dialect: 'postgres', connection });
const logDir = mkdtempSync(join(tmpdir(), 'jscrawl-crawltools-'));
const SLEEPER = `process.stdout.write('child up\\n');
process.on('SIGTERM', () => { process.stdout.write('bye\\n'); process.exit(0); });
setInterval(() => {}, 1000);`;
const supervisor = new Supervisor(db, {
  cwd: process.cwd(),
  logDir,
  crawlCommand: () => ['node', '-e', SLEEPER],
  oneshotCommand: () => ['node', '-e', SLEEPER],
});
const config = { database: { dialect: 'postgres', connection }, store: {} } as any;
// the crawl tools drive the Supervisor through the jscrawl HTTP API, so serve it here,
// signed in as the service the way the agent's tool server is
const API_TOKEN = 'test-api-token-0123456789';
let server: Server;
let tools: DomainTool[] = [];
const tool = (name: string) => tools.find((t) => t.name === name)!;
const ctx = { cwd: process.cwd() };

let siteId: number;
let urlId: number;

beforeAll(async () => {
  await supervisor.init();
  server = createServer(
    webHandler({
      db,
      config,
      supervisor,
      cwd: process.cwd(),
      apiToken: API_TOKEN,
    })
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const jscrawlUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  tools = domainTools({ db, config, cwd: process.cwd(), jscrawlUrl, apiToken: API_TOKEN, imagedUrl: 'http://127.0.0.1:1' });
});
afterAll(async () => {
  server.close();
  await supervisor.shutdown();
  await db.end();
  rmSync(logDir, { recursive: true, force: true });
});
beforeEach(async () => {
  await supervisor.shutdown();
  await db.query('truncate crawler_run, url, site, crawler cascade');
  await db.query("insert into crawler (name) values ('tools')");
  await db.query("insert into site (name, crawler_id) select 'tools', id from crawler where name = 'tools'");
  [{ id: siteId }] = await db.query<any[]>("select id from site where name = 'tools'");
  [{ id: urlId }] = await db.query<any[]>(
    "insert into url (site_id, type, url, hash, status) values (?, 'product', 'https://tools.test/p', ?, 2) returning id",
    siteId, sha1('https://tools.test/p')
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
const booted = async () => (await tool('crawlLog').execute({ site: 'tools' }, ctx)).includes('child up');

test('crawlStatus reports sites and, for one site, its runs', async () => {
  const all = JSON.parse(await tool('crawlStatus').execute({}, ctx));
  expect(all.crawlers).toEqual([
    expect.objectContaining({ siteId, siteName: 'tools', running: false, lastStatus: null }),
  ]);
  const one = JSON.parse(await tool('crawlStatus').execute({ site: 'tools' }, ctx));
  expect(one.runs).toEqual([]);
  expect(await tool('crawlStatus').execute({ site: 'nope' }, ctx)).toMatch(/Error: No site nope/);
});

test('start/stop/restart drive the supervisor and surface guard errors as text', async () => {
  const started = JSON.parse(await tool('crawlStart').execute({ site: 'tools' }, ctx));
  expect(started.runId).toBeGreaterThan(0);
  expect(await tool('crawlStart').execute({ site: String(siteId) }, ctx)).toMatch(
    /Error: a crawl for tools is already running/
  );

  await waitFor(booted, 'the child to boot');
  expect(await tool('crawlStop').execute({ site: 'tools' }, ctx)).toBe('{"stopped":true}');
  await waitFor(
    async () => (await db.query<any[]>('select status from crawler_run where id = ?', started.runId))[0].status === 'stopped',
    'the run to stop'
  );
  expect(await tool('crawlStop').execute({ site: 'tools' }, ctx)).toMatch(/Error: no crawl is running/);

  const restarted = JSON.parse(await tool('crawlRestart').execute({ site: 'tools' }, ctx));
  expect(restarted.runId).not.toBe(started.runId);
  const log = await tool('crawlLog').execute({ site: 'tools', runId: restarted.runId }, ctx);
  expect(typeof log).toBe('string');
  await supervisor.shutdown();
});

test('requeueUrl idles a url or refuses a one-shot while the crawl runs', async () => {
  expect(await tool('requeueUrl').execute({ url: 'https://tools.test/p' }, ctx)).toBe('{"queued":true}');
  expect((await db.query<any[]>('select status from url where id = ?', urlId))[0].status).toBe(0);
  expect(await tool('requeueUrl').execute({ url: String(urlId), mode: 'bogus' }, ctx)).toMatch(/mode must be/);

  const runId = await supervisor.start(siteId);
  expect(await tool('requeueUrl').execute({ url: String(urlId), mode: 'oneshot' }, ctx)).toMatch(
    /Error: a crawl for tools is running/
  );
  await supervisor.shutdown();
  await waitFor(
    async () => (await db.query<any[]>('select status from crawler_run where id = ?', runId))[0].status !== 'running',
    'the crawl to stop'
  );
  const oneshot = JSON.parse(await tool('requeueUrl').execute({ url: String(urlId), mode: 'oneshot' }, ctx));
  expect(oneshot.runId).toBeGreaterThan(0);
  await supervisor.shutdown();
});
