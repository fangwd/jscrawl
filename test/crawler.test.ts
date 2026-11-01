import { createServer, Server } from 'http';
import { AddressInfo } from 'net';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import Crawler from '../src/core/crawler';
import { CrawlerDatabase } from '../src/core/database';
import { SiteUrl, UrlStatus } from '../src/core/models';
import { XDocument } from 'gumbo-html';
import { readPage, Response } from '../src/core/fetch';

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

class ShopCrawler extends Crawler {
  async scrapeProduct(doc: XDocument) {
    const product = this.db.addProduct({ code: 'P1', name: doc.innerText }, { detailed: true });
    this.db.addProductUrl(product, this.siteUrl.id, null);
    this.db.addVariant(product, { price: 9.5 });
  }
}

/** Prices its product from an API its page handler fetches. */
class ApiCrawler extends Crawler {
  async scrapeProduct(doc: XDocument) {
    const response = await this.fetch(`${base}/api/price`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-requested-with': 'XMLHttpRequest' },
      body: JSON.stringify({ code: 'P1' }),
    });
    const { price } = JSON.parse(response.text());
    const product = this.db.addProduct({ code: 'P1', name: doc.innerText }, { detailed: true });
    this.db.addProductUrl(product, this.siteUrl.id, null);
    this.db.addVariant(product, { price });
  }
}

let server: Server;
let base: string;
let db: CrawlerDatabase;
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
    if (req.url === '/api/price') {
      let body = '';
      req.on('data', (chunk) => (body += chunk)).on('end', () => {
        const ok = req.method === 'POST' && req.headers['x-requested-with'] === 'XMLHttpRequest' && JSON.parse(body).code === 'P1';
        res.writeHead(ok ? 200 : 400, { 'content-type': 'application/json' }).end(JSON.stringify({ price: 10 + apiCalls++ }));
      });
    } else if (req.url === '/robots.txt') {
      res.writeHead(robots.status, { 'content-type': 'text/plain' }).end(robots.body);
    } else if (req.url === '/p1') {
      res.writeHead(200, { 'content-type': 'text/html' }).end('Pad Thai');
    } else if (req.url === '/old') {
      res.writeHead(301, { location: '/p1' }).end();
    } else if (req.url === '/spec') {
      res.writeHead(200, { 'content-type': 'text/html' }).end(
        '<table>' + '<tr><th>Material</th><td>Brass</td></tr>'.repeat(4) + '</table>');
    } else {
      res.writeHead(404, { 'content-type': 'text/html' }).end('Not found');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  db = new CrawlerDatabase(connection);
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
  const crawler = db.table('crawler').append({ name: 'shop', maxRetryCount: 0 });
  const site = db.table('site').append({ name: 'shop', crawler });
  db.table('url').append({ site, url: `${base}/p1`, hash: 'p1', type: 'product' });
  await db.flush();
  db.clear();
  await db.init('shop');
  // a directory that does not exist yet: saving creates it
  html = join(mkdtempSync(join(tmpdir(), 'jscrawl-')), 'data', 'html');
});

const getUrl = async () =>
  (await db.table('url').select({ site: '*' }))[0] as unknown as SiteUrl;

test('process fetches, saves, scrapes and records the fetch', async () => {
  const crawler = new ShopCrawler(db, { database: connection, store: { html } });
  await crawler.process(await getUrl());

  const url = await getUrl();
  expect(url.status).toBe(UrlStatus.Done);
  expect(url.version).toBe(1);

  const [fetch] = await db.table('url_fetch').select('*');
  expect(fetch.httpStatus).toBe(200);
  expect(fetch.finalUrl).toBe(`${base}/p1`);
  expect(fetch.contentLength).toBe(8);
  expect(fetch.contentHash).toHaveLength(32);

  const [price] = await db.table('variant_price').select('*');
  expect((price.urlFetch as any).id).toBe(fetch.id);

  const [product] = await db.table('product').select('*');
  expect(product.name).toBe('Pad Thai');
  expect(readdirSync(html)).toEqual([`${url.id}.0`]);
  const snapshot = join(html, `${url.id}.0`);
  expect(JSON.parse(readFileSync(snapshot, 'utf8').split('\n')[0])._encoding).toBe('gzip');
  expect((await Response.load(snapshot)).text()).toBe('Pad Thai');
});

test('raw snapshots retain the uncompressed response format', async () => {
  db.site.crawler.pageSnapshots = 'raw';
  const crawler = new ShopCrawler(db, { database: connection, store: { html } });
  const url = await getUrl();
  await crawler.process(url);
  const snapshot = join(html, `${url.id}.0`);
  expect(JSON.parse(readFileSync(snapshot, 'utf8').split('\n')[0])._encoding).toBeNull();
  expect((await Response.load(snapshot)).text()).toBe('Pad Thai');
});

test('storage off keeps fetches, extracted data and page validation without creating files', async () => {
  db.site.crawler.pageSnapshots = 'off';
  await db.table('url').update({ url: `${base}/spec` }, { hash: 'p1' });
  const crawler = new ShopCrawler(db, { database: connection, store: { html } });
  await crawler.process(await getUrl());
  expect(existsSync(html)).toBe(false);
  expect((await getUrl()).status).toBe(UrlStatus.Done);
  expect(await db.table('url_fetch').select('*')).toHaveLength(1);
  expect(await db.table('product').select('*')).toHaveLength(1);
  expect(await crawler.validate(await getUrl())).toEqual(expect.arrayContaining([
    expect.stringMatching(/spec-like table/),
  ]));
});

test('a 404 marks the url failed and its products gone', async () => {
  const crawler = new ShopCrawler(db, { database: connection, store: { html } });
  await crawler.process(await getUrl());

  await db.table('url').update({ url: `${base}/gone` }, { hash: 'p1' });
  await crawler.process(await getUrl());

  expect((await getUrl()).status).toBe(UrlStatus.FetchFailed);
  const [product] = await db.table('product').select('*');
  expect(product.status).toBe('gone');
});

test('redirects record the final url', async () => {
  await db.table('url').update({ url: `${base}/old` }, { hash: 'p1' });
  const crawler = new ShopCrawler(db, { database: connection, store: { html } });
  await crawler.process(await getUrl());

  const [fetch] = await db.table('url_fetch').select('*');
  expect(fetch.finalUrl).toBe(`${base}/p1`);
  expect((await getUrl()).status).toBe(UrlStatus.Done);
});

test('a transport error is recorded on the fetch', async () => {
  await db.table('url').update({ url: 'http://127.0.0.1:1/p1' }, { hash: 'p1' });
  const crawler = new ShopCrawler(db, { database: connection, store: { html } });
  await crawler.process(await getUrl());

  expect((await getUrl()).status).toBe(UrlStatus.FetchFailed);
  const [fetch] = await db.table('url_fetch').select('*');
  expect(fetch.httpStatus).toBeNull();
  expect(fetch.error).toMatch(/ECONNREFUSED/);
});

test('pages of a type the crawler does not handle fail to scrape', async () => {
  await db.table('url').update({ type: 'category' }, { hash: 'p1' });
  const crawler = new ShopCrawler(db, { database: connection, store: { html } });
  await crawler.process(await getUrl());

  expect((await getUrl()).status).toBe(UrlStatus.ScrapeFailed);
});

test('a handler\'s fetch is paced as robots.txt asks, saved beside the snapshot and replayed on re-scrape', async () => {
  const crawler = new ApiCrawler(db, { database: connection, store: { html } });
  const url = await getUrl();
  await crawler.process(url);

  expect(requested).toEqual(['/robots.txt', '/p1', '/api/price']);
  expect(arrived['/api/price'] - arrived['/p1']).toBeGreaterThanOrEqual(300);
  const [variant] = await db.table('product_variant').select('*');
  expect(Number(variant.price)).toBe(10);
  const fetches = join(html, `${url.id}.${url.version}.fetches`);
  expect(readdirSync(fetches)).toHaveLength(1);

  // the snapshot's re-scrape answers the handler from what the crawl fetched
  const replay = new ApiCrawler(db, { database: connection, store: { html } });
  replay.fetches = { dir: fetches };
  await replay.scrape(await Response.load(join(html, `${url.id}.${url.version}`)), url);
  expect(requested).toHaveLength(3);
  const [replayed] = db.table('product_variant').recordList;
  expect(replayed.get('price')).toBe(10);
  db.clear();
});

test('a fixture\'s first scrape records what its handler fetches and later scrapes replay it', async () => {
  const url = await getUrl();
  const fixture = join(html, 'product.html');
  mkdirSync(html, { recursive: true });
  writeFileSync(fixture, 'Pad Thai');
  const prices = [];
  for (let run = 0; run < 2; run++) {
    const crawler = new ApiCrawler(db, { database: connection });
    crawler.fetches = { dir: `${fixture}.fetches` };
    await crawler.scrape(await readPage(fixture, url.url), url);
    prices.push(db.table('product_variant').recordList[0].get('price'));
    db.clear();
  }
  expect(requested).toEqual(['/robots.txt', '/api/price']);
  expect(prices).toEqual([10, 10]);
});

test('the run loop skips urls the path rules disallow and reads robots.txt first', async () => {
  // rules tightened after /blocked was queued
  db.table('url').append({ site: db.site.id, url: `${base}/blocked`, hash: 'blocked', type: 'product' });
  await db.flush();
  db.clear();
  await db.table('crawler').update({ disallow: ['/blocked'] }, { name: 'shop' });
  await db.init('shop');

  const crawler = new ShopCrawler(db, { database: connection, store: { html } });
  // both urls are claimed, in either order; the third claim finds the queue empty
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
});

describe("the site's robots.txt", () => {
  const status = async () => (await getUrl()).status;
  const fetchErrors = async () => (await db.table('url_fetch').select('*')).map((f: any) => f.error);

  test('a page it disallows is recorded as disallowed and never fetched', async () => {
    robots = { status: 200, body: 'User-agent: *\nDisallow: /p1\n' };
    await new ShopCrawler(db, { database: connection, store: { html } }).process(await getUrl());
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
    await new ShopCrawler(db, { database: connection, store: { html } }).process(await getUrl());
    expect(requested).toEqual(['/robots.txt', '/p1']);
    expect(await status()).toBe(UrlStatus.Done);
  });

  test('one the host cannot serve fetches nothing, and the page stays retryable', async () => {
    robots = { status: 503, body: 'down' };
    await new ShopCrawler(db, { database: connection, store: { html } }).process(await getUrl());
    expect(requested).toEqual(['/robots.txt']);
    expect(await status()).toBe(UrlStatus.FetchFailed);
    expect(await fetchErrors()).toEqual([expect.stringMatching(/robots\.txt is unreachable \(HTTP 503\)/)]);
  });
});
