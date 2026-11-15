import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { createServer, Server } from 'http';
import { AddressInfo } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';

import { XDocument } from 'gumbo-html';

import { readPage, Response } from '../src/core/fetch';
import { SiteUrl, UrlStatus } from '../src/core/models';
import { openRun } from '../src/core/runs';
import { TestCrawler, TestDatabase } from './support/domain';

const connection = {
  dialect: 'postgres' as const,
  connection: {
    host: '127.0.0.1',
    port: 5434,
    user: 'admin',
    password: 'secret',
    database: 'jscrawl_test',
  },
};

class PageCrawler extends TestCrawler {
  async scrapePage(doc: XDocument) {
    this.db.addPage(this.siteUrl, doc.innerText);
  }
}

/** Fills a page's body from an API its handler fetches. */
class ApiCrawler extends TestCrawler {
  async scrapePage(doc: XDocument) {
    const response = await this.fetch(`${base}/api/body`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-requested-with': 'XMLHttpRequest',
      },
      body: JSON.stringify({ code: 'P1' }),
    });
    const { body } = JSON.parse(response.text());
    this.db.addPage(this.siteUrl, doc.innerText, body);
  }
}

let server: Server;
let base: string;
let db: TestDatabase;
let html: string;
let requested: string[];
/** When each request arrived, by path. */
let arrived: { [path: string]: number };
let apiCalls: number;
/** What the server answers for /robots.txt. */
let robots: { status: number; body: string };

beforeAll(async () => {
  server = createServer((req, res) => {
    requested.push(req.url!);
    arrived[req.url!] = Date.now();
    if (req.url === '/api/body') {
      let body = '';
      req
        .on('data', (chunk) => (body += chunk))
        .on('end', () => {
          const ok =
            req.method === 'POST' &&
            req.headers['x-requested-with'] === 'XMLHttpRequest' &&
            JSON.parse(body).code === 'P1';
          res
            .writeHead(ok ? 200 : 400, { 'content-type': 'application/json' })
            .end(JSON.stringify({ body: `call ${apiCalls++}` }));
        });
    } else if (req.url === '/robots.txt') {
      res.writeHead(robots.status, { 'content-type': 'text/plain' }).end(robots.body);
    } else if (req.url === '/p1' || req.url === '/p2') {
      res.writeHead(200, { 'content-type': 'text/html' }).end('Pad Thai');
    } else if (req.url === '/old') {
      res.writeHead(301, { location: '/p1' }).end();
    } else if (req.url === '/blank') {
      res.writeHead(200, { 'content-type': 'text/html' }).end('<p></p>');
    } else {
      res.writeHead(404, { 'content-type': 'text/html' }).end('Not found');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  db = new TestDatabase(connection);
  await db.buildSchema();
});

afterAll(async () => {
  await db.end();
  server.close();
});

beforeEach(async () => {
  await db.zap();
  requested = [];
  arrived = {};
  apiCalls = 0;
  robots = { status: 200, body: 'User-agent: *\nCrawl-delay: 0.3\n' };
  const crawler = db.table('crawler').append({ name: 'site', maxRetryCount: 0 });
  const site = db.table('site').append({ name: 'site', crawler });
  db.table('url').append({ site, url: `${base}/p1`, hash: 'p1', type: 'page' });
  await db.flush();
  db.clear();
  await db.init('site');
  // a directory that does not exist yet: saving creates it
  html = join(mkdtempSync(join(tmpdir(), 'jscrawl-')), 'data', 'html');
});

const getUrl = async () => (await db.table('url').select({ site: '*' }))[0] as unknown as SiteUrl;
const pages = () => db.table('page').select('*') as Promise<any[]>;

test('process fetches, saves, scrapes and records the fetch', async () => {
  const crawler = new PageCrawler(db, {
    database: connection,
    store: { html },
  });
  await crawler.process(await getUrl());

  const url = await getUrl();
  expect(url.status).toBe(UrlStatus.Done);
  expect(url.version).toBe(1);

  const [fetch] = await db.table('url_fetch').select('*');
  expect(fetch.httpStatus).toBe(200);
  expect(fetch.finalUrl).toBe(`${base}/p1`);
  expect(fetch.contentLength).toBe(8);
  expect(fetch.contentHash).toHaveLength(32);

  const [page] = await pages();
  expect(page.title).toBe('Pad Thai');
  expect(readdirSync(html)).toEqual([`${url.id}.0`]);
  const snapshot = join(html, `${url.id}.0`);
  expect(JSON.parse(readFileSync(snapshot, 'utf8').split('\n')[0])._encoding).toBe('gzip');
  expect((await Response.load(snapshot)).text()).toBe('Pad Thai');
});

test('a fetch is recorded under the run that made it, a failed one too', async () => {
  const run = await openRun(db, { siteId: db.site.id, kind: 'oneshot' });
  db.table('url').append({
    site: db.site.id,
    url: 'http://127.0.0.1:1/unreachable',
    hash: 'down',
    type: 'page',
  });
  await db.flush();
  db.clear();
  db.runId = run;
  try {
    const crawler = new PageCrawler(db, {
      database: connection,
      store: { html },
    });
    for (const url of (await db.table('url').select({ site: '*' })) as unknown as SiteUrl[])
      await crawler.process(url);
  } finally {
    db.runId = null;
  }
  const fetches = await db.query<any[]>(
    'select http_status, error is not null as failed, run_id from url_fetch order by http_status',
  );
  expect(fetches.map((f) => [f.http_status, f.failed, Number(f.run_id)])).toEqual([
    [200, false, run],
    [null, true, run],
  ]);
});

test('raw snapshots retain the uncompressed response format', async () => {
  db.site.crawler.pageSnapshots = 'raw';
  const crawler = new PageCrawler(db, {
    database: connection,
    store: { html },
  });
  const url = await getUrl();
  await crawler.process(url);
  const snapshot = join(html, `${url.id}.0`);
  expect(JSON.parse(readFileSync(snapshot, 'utf8').split('\n')[0])._encoding).toBeNull();
  expect((await Response.load(snapshot)).text()).toBe('Pad Thai');
});

test('storage off keeps fetches, extracted data and page validation without creating files', async () => {
  db.site.crawler.pageSnapshots = 'off';
  await db.table('url').update({ url: `${base}/blank` }, { hash: 'p1' });
  const crawler = new PageCrawler(db, {
    database: connection,
    store: { html },
  });
  await crawler.process(await getUrl());
  expect(existsSync(html)).toBe(false);
  expect((await getUrl()).status).toBe(UrlStatus.Done);
  expect(await db.table('url_fetch').select('*')).toHaveLength(1);
  expect(await pages()).toHaveLength(1);
  expect(await crawler.validate(await getUrl())).toEqual([
    { code: 'no_title', detail: 'page has no title' },
  ]);
  const [issue] = await db.table('issue').select('*');
  expect(issue).toMatchObject({
    kind: 'validation',
    problem: 'no_title',
    detail: 'page has no title',
  });
});

test('a page the scraper vouched for is not validated', async () => {
  await db
    .table('url')
    .update({ url: `${base}/blank`, data: 'a blank landing page' }, { hash: 'p1' });
  await new PageCrawler(db, { database: connection, store: { html } }).process(await getUrl());
  expect(await db.table('issue').select('*')).toHaveLength(0);
});

test('a 404 marks the url failed and tells the domain its page is gone', async () => {
  const crawler = new PageCrawler(db, {
    database: connection,
    store: { html },
  });
  await crawler.process(await getUrl());

  await db.table('url').update({ url: `${base}/gone` }, { hash: 'p1' });
  await crawler.process(await getUrl());

  expect((await getUrl()).status).toBe(UrlStatus.FetchFailed);
  const [page] = await pages();
  expect(page.status).toBe('gone');
});

test('redirects record the final url', async () => {
  await db.table('url').update({ url: `${base}/old` }, { hash: 'p1' });
  const crawler = new PageCrawler(db, {
    database: connection,
    store: { html },
  });
  await crawler.process(await getUrl());

  const [fetch] = await db.table('url_fetch').select('*');
  expect(fetch.finalUrl).toBe(`${base}/p1`);
  expect((await getUrl()).status).toBe(UrlStatus.Done);
});

test('a transport error is recorded on the fetch', async () => {
  await db.table('url').update({ url: 'http://127.0.0.1:1/p1' }, { hash: 'p1' });
  const crawler = new PageCrawler(db, {
    database: connection,
    store: { html },
  });
  await crawler.process(await getUrl());

  expect((await getUrl()).status).toBe(UrlStatus.FetchFailed);
  const [fetch] = await db.table('url_fetch').select('*');
  expect(fetch.httpStatus).toBeNull();
  expect(fetch.error).toMatch(/ECONNREFUSED/);
});

test('pages of a type the domain does not declare fail to scrape, and cannot be queued', async () => {
  await db.query("update url set type = 'article' where hash = 'p1'");
  const crawler = new PageCrawler(db, {
    database: connection,
    store: { html },
  });
  await crawler.process(await getUrl());
  expect((await getUrl()).status).toBe(UrlStatus.ScrapeFailed);
  expect(() => db.addUrl(`${base}/other`, 'article', null)).toThrow(/Unknown url type "article"/);
});

test("a handler's fetch is paced as robots.txt asks, saved beside the snapshot and replayed on re-scrape", async () => {
  const crawler = new ApiCrawler(db, { database: connection, store: { html } });
  const url = await getUrl();
  await crawler.process(url);

  expect(requested).toEqual(['/robots.txt', '/p1', '/api/body']);
  // requests are sent 300ms apart; their transit to the server varies by a few ms
  expect(arrived['/api/body'] - arrived['/p1']).toBeGreaterThanOrEqual(250);
  const [page] = await pages();
  expect(page.body).toBe('call 0');
  const fetches = join(html, `${url.id}.${url.version}.fetches`);
  expect(readdirSync(fetches)).toHaveLength(1);

  // the snapshot's re-scrape answers the handler from what the crawl fetched
  const replay = new ApiCrawler(db, { database: connection, store: { html } });
  replay.fetches = { dir: fetches };
  await replay.scrape(await Response.load(join(html, `${url.id}.${url.version}`)), url);
  expect(requested).toHaveLength(3);
  const [replayed] = db.table('page').recordList;
  expect(replayed.get('body')).toBe('call 0');
  db.clear();
});

test("a fixture's first scrape records what its handler fetches and later scrapes replay it", async () => {
  const url = await getUrl();
  const fixture = join(html, 'page.html');
  mkdirSync(html, { recursive: true });
  writeFileSync(fixture, 'Pad Thai');
  const bodies = [];
  for (let run = 0; run < 2; run++) {
    const crawler = new ApiCrawler(db, { database: connection });
    crawler.fetches = { dir: `${fixture}.fetches` };
    await crawler.scrape(await readPage(fixture, url.url), url);
    bodies.push(db.table('page').recordList[0].get('body'));
    db.clear();
  }
  expect(requested).toEqual(['/robots.txt', '/api/body']);
  expect(bodies).toEqual(['call 0', 'call 0']);
});

test('the run loop claims the declared page types, skips urls the path rules disallow and reads robots.txt first', async () => {
  // rules tightened after /blocked was queued
  db.table('url').append({
    site: db.site.id,
    url: `${base}/blocked`,
    hash: 'blocked',
    type: 'page',
  });
  db.table('url').append({
    site: db.site.id,
    url: `${base}/image.png`,
    hash: 'image',
    type: 'image',
  });
  await db.flush();
  db.clear();
  await db.table('crawler').update({ disallow: ['/blocked'] }, { name: 'site' });
  await db.init('site');

  const crawler = new PageCrawler(db, {
    database: connection,
    store: { html },
  });
  // both pages are claimed, in either order; the third claim finds the queue empty
  const claimUrl = db.claimUrl.bind(db);
  let claims = 0;
  db.claimUrl = (filter) => {
    if (++claims === 3) crawler.stop.requested = true;
    return claimUrl(filter);
  };
  await crawler.run();

  expect(requested).toEqual(['/robots.txt', '/p1']);
  const [blocked] = await db.table('url').select('*', { where: { hash: 'blocked' } });
  expect(blocked.status).toBe(UrlStatus.Disallowed);
  const [image] = await db.table('url').select('*', { where: { hash: 'image' } });
  expect(image.status).toBe(UrlStatus.Idle);
});

test("the site row's threadCount runs that many loops, sharing robots.txt and the site's pace", async () => {
  db.table('url').append({
    site: db.site.id,
    url: `${base}/p2`,
    hash: 'p2',
    type: 'page',
  });
  await db.flush();
  db.clear();
  await db.table('site').update({ threadCount: 2 }, { name: 'site' });
  await db.init('site');

  const crawler = new PageCrawler(db, {
    database: connection,
    store: { html },
  });
  // each loop claims on its own database clone; the first empty claim stops the crawl
  const claimUrl = TestDatabase.prototype.claimUrl;
  const claimers = new Set<TestDatabase>();
  const spy = jest.spyOn(TestDatabase.prototype, 'claimUrl').mockImplementation(async function (
    this: TestDatabase,
    filter,
  ) {
    claimers.add(this);
    const url = await claimUrl.call(this, filter);
    if (!url) crawler.stop.requested = true;
    return url;
  });
  try {
    await crawler.start();
  } finally {
    spy.mockRestore();
  }

  expect(claimers.size).toBe(2);
  expect([...requested].sort()).toEqual(['/p1', '/p2', '/robots.txt']);
  expect(Math.abs(arrived['/p2'] - arrived['/p1'])).toBeGreaterThanOrEqual(250);
  const urls = await db.table('url').select('*');
  expect(urls.map((u: any) => u.status)).toEqual([UrlStatus.Done, UrlStatus.Done]);
});

describe("the site's robots.txt", () => {
  const status = async () => (await getUrl()).status;
  const fetchErrors = async () =>
    (await db.table('url_fetch').select('*')).map((f: any) => f.error);

  test('a page it disallows is recorded as disallowed and never fetched', async () => {
    robots = { status: 200, body: 'User-agent: *\nDisallow: /p1\n' };
    await new PageCrawler(db, {
      database: connection,
      store: { html },
    }).process(await getUrl());
    expect(requested).toEqual(['/robots.txt']);
    expect(await status()).toBe(UrlStatus.Disallowed);
    expect(await fetchErrors()).toEqual([]);
  });

  test('a handler fetch it disallows fails the scrape', async () => {
    robots = { status: 200, body: 'User-agent: *\nDisallow: /api/\n' };
    await new ApiCrawler(db, { database: connection, store: { html } }).process(await getUrl());
    expect(requested).toEqual(['/robots.txt', '/p1']);
    expect(await status()).toBe(UrlStatus.ScrapeFailed);
  });

  test('a missing one allows everything', async () => {
    robots = { status: 404, body: 'Not found' };
    await new PageCrawler(db, {
      database: connection,
      store: { html },
    }).process(await getUrl());
    expect(requested).toEqual(['/robots.txt', '/p1']);
    expect(await status()).toBe(UrlStatus.Done);
  });

  test('one the host cannot serve fetches nothing, and the page stays retryable', async () => {
    robots = { status: 503, body: 'down' };
    await new PageCrawler(db, {
      database: connection,
      store: { html },
    }).process(await getUrl());
    expect(requested).toEqual(['/robots.txt']);
    expect(await status()).toBe(UrlStatus.FetchFailed);
    expect(await fetchErrors()).toEqual([
      expect.stringMatching(/robots\.txt is unreachable \(HTTP 503\)/),
    ]);
  });
});
