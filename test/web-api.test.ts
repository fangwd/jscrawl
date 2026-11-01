import { strFromU8, unzipSync } from 'fflate';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { createServer, Server } from 'http';
import { AddressInfo } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';
import { Database } from 'sqlex';
import { Response } from '../src/core/fetch';
import { sha1 } from '../src/core/utils';
import { Supervisor } from '../src/core/supervisor';
import { webHandler } from '../src/web/routes';

// Every route needs the service token (web-auth.test.ts); these call the API as
// spidermake does, with it.
const API_TOKEN = 'test-api-token-0123456789';
const fetch: typeof globalThis.fetch = (input, init = {}) =>
  globalThis.fetch(input, { ...init, headers: { authorization: `Bearer ${API_TOKEN}`, ...(init.headers as object) } });

const db = new Database({
  dialect: 'postgres',
  connection: { host: '127.0.0.1', port: 5434, user: 'admin', password: 'secret', database: 'jscrawl_test' },
});
const htmlDir = mkdtempSync(join(tmpdir(), 'jscrawl-web-html-'));
const logDir = mkdtempSync(join(tmpdir(), 'jscrawl-web-log-'));
const supervisor = new Supervisor(db, {
  cwd: process.cwd(),
  logDir,
  crawlCommand: () => ['node', '-e', 'process.exit(0)'],
});
const config = { store: { html: htmlDir } } as any;

let server: Server;
let base: string;
let liveServer: Server;
let liveBase: string;

const LIVE_PAGE = `<html><head><script type="application/ld+json">
{"@context":"https://schema.org","@type":"Product","name":"Live Widget","sku":"LW-1",
 "offers":{"@type":"Offer","price":12.34,"priceCurrency":"AUD","availability":"https://schema.org/InStock"}}
</script></head><body></body></html>`;
let siteId: number;
let productUrlId: number;
let issueId: number;

beforeAll(async () => {
  liveServer = createServer((req, res) => res.writeHead(200, { 'content-type': 'text/html' }).end(LIVE_PAGE));
  await new Promise<void>((resolve) => liveServer.listen(0, '127.0.0.1', resolve));
  liveBase = `http://127.0.0.1:${(liveServer.address() as AddressInfo).port}`;
  server = createServer(
    webHandler({ db, config, supervisor, apiToken: API_TOKEN })
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.close();
  liveServer.close();
  await supervisor.shutdown();
  await db.end();
  rmSync(htmlDir, { recursive: true, force: true });
  rmSync(logDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await db.query('truncate issue, product, url, site, crawler cascade');
  await db.query("insert into crawler (name) values ('web')");
  await db.query("insert into site (name, crawler_id, currency) select 'web', id, 'AUD' from crawler where name = 'web'");
  [{ id: siteId }] = await db.query<any[]>("select id from site where name = 'web'");
  await db.query(
    "insert into url (site_id, type, url, hash, status, version) values (?, 'seed', 'https://web.test/', ?, 2, 1)",
    siteId, sha1('https://web.test/')
  );
  const [category] = await db.query<any[]>(
    "insert into url (site_id, type, url, hash, status, version) values (?, 'category', 'https://web.test/c', ?, 2, 1) returning id",
    siteId, sha1('https://web.test/c')
  );
  const [product] = await db.query<any[]>(
    "insert into url (site_id, type, url, hash, status, version) values (?, 'product', 'https://web.test/p', ?, 2, 1) returning id",
    siteId, sha1('https://web.test/p')
  );
  productUrlId = Number(product.id);
  const [seed] = await db.query<any[]>("select id from url where url = 'https://web.test/'");
  await db.query('insert into url_graph (src_id, dst_id) values (?, ?)', seed.id, productUrlId);
  await db.query(
    "insert into url_fetch (url_id, fetch_time, http_status, final_url, content_type, content_length) values (?, now(), 200, 'https://web.test/p', 'text/html', 27)",
    productUrlId
  );
  const [widget] = await db.query<any[]>(
    "insert into product (site_id, code, name) values (?, 'W1', 'Widget') returning id", siteId
  );
  const [variant] = await db.query<any[]>(
    "insert into product_variant (product_id, code, price, availability) values (?, '', 9.99, 'in_stock') returning id",
    widget.id
  );
  await db.query('insert into product_url (product_id, url_id) values (?, ?)', widget.id, productUrlId);
  await db.query(
    "insert into variant_price (variant_id, observed_at, currency, price, availability) values (?, now(), 'AUD', 9.99, 'in_stock')",
    variant.id
  );
  const [issue] = await db.query<any[]>(
    "insert into issue (url_id, kind, detail) values (?, 'validation', 'no variant has a positive price') returning id",
    productUrlId
  );
  issueId = Number(issue.id);
  await new Response({
    url: 'https://web.test/p',
    requestUrl: 'https://web.test/p',
    statusCode: 200,
    headers: { 'content-type': 'text/html' },
    httpVersion: '1.1',
    body: Buffer.from('<html><body>hi</body></html>'),
    fetchStart: new Date(),
    fetchEnd: new Date(),
  }).save(join(htmlDir, `${productUrlId}.0`), { compress: true });
});

const get = async (path: string) => {
  const res = await fetch(base + path);
  expect(res.status).toBe(200);
  return res.json() as Promise<any>;
};

test('overview aggregates sites and totals', async () => {
  const { sites, totals } = await get('/api/overview');
  expect(sites).toHaveLength(1);
  expect(sites[0]).toMatchObject({ name: 'web', currency: 'AUD', products: 1 });
  expect(sites[0].urls).toEqual({ seed: { done: 1 }, category: { done: 1 }, product: { done: 1 } });
  expect(sites[0].issues).toMatchObject({ open: 1 });
  expect(sites[0].crawler).toMatchObject({ waitTime: 0, usePuppeteer: false, pageSnapshots: 'gzip' });
  expect(totals).toEqual({ sites: 1, urls: 3, products: 1, openIssues: 1 });
});

test('a crawler is saved over the version it was opened at, and refused over a newer one', async () => {
  const sitesDir = mkdtempSync(join(tmpdir(), 'jscrawl-web-sites-'));
  config.sites = { dir: sitesDir };
  try {
    writeFileSync(join(sitesDir, 'web.ts'), 'export const v = 1;\n');
    const opened = await get(`/api/sites/${siteId}/crawler`);
    expect(opened).toMatchObject({ name: 'web', code: 'export const v = 1;\n', hash: sha1('export const v = 1;\n') });

    const put = (body: unknown, type = 'application/json') =>
      fetch(`${base}/api/sites/${siteId}/crawler`, { method: 'PUT', headers: { 'content-type': type }, body: JSON.stringify(body) });
    const saved = await put({ code: 'export const v = 2;\n', hash: opened.hash });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({ code: 'export const v = 2;\n', hash: sha1('export const v = 2;\n') });
    expect(readFileSync(join(sitesDir, 'web.ts'), 'utf8')).toBe('export const v = 2;\n');

    // saved meanwhile (by the agent): an edit of the version first opened is refused, with the file as it is now
    const stale = await put({ code: 'export const v = 3;\n', hash: opened.hash });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ code: 'export const v = 2;\n' });
    expect(readFileSync(join(sitesDir, 'web.ts'), 'utf8')).toBe('export const v = 2;\n');

    expect((await put({ code: 'x' })).status).toBe(400);
    expect((await put({ code: 'x', hash: opened.hash }, 'text/plain')).status).toBe(415);
    const missing = await fetch(`${base}/api/sites/999999/crawler`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(missing.status).toBe(404);
  } finally {
    delete config.sites;
    rmSync(sitesDir, { recursive: true, force: true });
  }
});

test('sites count problems, not pages: verdicts awaiting review and open page-type/kind groups', async () => {
  // one triaged verdict copied onto two other pages, and one page still open
  const [a, b, c] = [await extraIssue(1), await extraIssue(2), await extraIssue(3)];
  await db.query("update issue set status = 'triaged', verdict = 'extractor_bug' where id in (?, ?, ?)", issueId, a, b);
  await db.query('update issue set same_as = ? where id in (?, ?)', issueId, a, b);
  const { sites } = await get('/api/overview');
  expect(sites[0].issues).toMatchObject({ open: 1, triaged: 3 });
  expect(sites[0].problems).toEqual({ open: 1, triaged: 1 });

  const originals = await get(`/api/issues?status=triaged&originals=1`);
  expect(originals.rows.map((r: any) => [r.id, r.copies])).toEqual([[issueId, 2]]);
  expect((await get('/api/issues?status=triaged')).total).toBe(3);
  expect((await get('/api/issues?status=open')).rows.map((r: any) => r.id)).toEqual([c]);
});

test('site detail includes the (missing) triage session link', async () => {
  const site = await get(`/api/sites/${siteId}`);
  expect(site).toMatchObject({ id: siteId, name: 'web' });
  expect((await fetch(`${base}/api/sites/999999`)).status).toBe(404);
});

test('urls list with filters and pagination', async () => {
  expect((await get('/api/urls')).total).toBe(3);
  const products = await get(`/api/sites/${siteId}/urls?type=product`);
  expect(products.rows.map((r: any) => r.url)).toEqual(['https://web.test/p']);
  expect(products.rows[0]).toMatchObject({ httpStatus: 200, siteName: 'web', status: 2, fetchError: null });
  expect((await get('/api/urls?q=web.test%2Fc')).rows.map((r: any) => r.type)).toEqual(['category']);
  expect((await get('/api/urls?status=2&pageSize=2&page=2')).rows).toHaveLength(1);
});

test('url detail bundles fetches, inbound links, issues and snapshots', async () => {
  const detail = await get(`/api/urls/${productUrlId}`);
  expect(detail.url).toMatchObject({ url: 'https://web.test/p', type: 'product', statusKey: 'done', siteName: 'web' });
  expect(detail.fetches).toHaveLength(1);
  expect(detail.fetches[0]).toMatchObject({ httpStatus: 200, contentType: 'text/html' });
  expect(detail.inbound.map((i: any) => i.url)).toEqual(['https://web.test/']);
  expect(detail.queued).toEqual([]);
  const [queuedUrl] = await db.query<any[]>(
    "insert into url (site_id, type, url, hash, status) values (?, 'product', 'https://web.test/q', ?, 0) returning id",
    siteId, sha1('https://web.test/q')
  );
  await db.query('insert into url_graph (src_id, dst_id) values (?, ?)', productUrlId, queuedUrl.id);
  expect((await get(`/api/urls/${productUrlId}`)).queued.map((q: any) => q.url)).toEqual(['https://web.test/q']);
  expect(detail.issues.map((i: any) => i.id)).toEqual([issueId]);
  expect(detail.snapshotVersions).toEqual(['0']);
});

test('url data serves the shared UrlReport', async () => {
  const [cat] = await db.query<any[]>(
    'insert into category (site_id, url_id, name) values (?, ?, ?) returning id',
    siteId, productUrlId, 'Shelf'
  );
  const [widget] = await db.query<any[]>("select id from product where code = 'W1'");
  await db.query('insert into product_category (product_id, category_id) values (?, ?)', widget.id, cat.id);

  const data = await get(`/api/urls/${productUrlId}/data`);
  expect(data.url).toMatchObject({ id: productUrlId, status: 2 });
  expect(data.lastFetch).toMatchObject({ httpStatus: 200 });
  expect(data.products[0]).toMatchObject({ code: 'W1', name: 'Widget' });
  expect(data.products[0].variants[0]).toMatchObject({ price: 9.99, availability: 'in_stock' });
  expect(data.products[0].variants[0].lastPrice).toMatchObject({ currency: 'AUD', price: 9.99 });
  expect(data.listed).toEqual([
    expect.objectContaining({ code: 'W1', pageUrl: 'https://web.test/p', pageStatus: 2 }),
  ]);
  expect(data.products[0].categories[0]).toMatchObject({ name: 'Shelf', urlId: productUrlId });
  await db.query("update product set structured_data = '{\"src\":\"test\"}' where code = 'W1'");
  expect((await get(`/api/urls/${productUrlId}/data`)).products[0].structuredData).toEqual({ src: 'test' });
});

test('snapshots are served inert, with sandbox headers', async () => {
  const res = await fetch(`${base}/api/urls/${productUrlId}/snapshot/0`);
  expect(res.status).toBe(200);
  expect(res.headers.get('content-security-policy')).toBe('sandbox');
  expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  expect(await res.text()).toBe('<html><body>hi</body></html>');
  expect((await fetch(`${base}/api/urls/${productUrlId}/snapshot/9`)).status).toBe(404);
  expect((await fetch(`${base}/api/urls/${productUrlId}/snapshot/..%2F..%2Fetc`)).status).toBe(404);
});

test('issues list and detail', async () => {
  const open = await get('/api/issues?status=open');
  expect(open.total).toBe(1);
  expect(open.rows[0]).toMatchObject({
    id: issueId, kind: 'validation', url: 'https://web.test/p', siteName: 'web', verdict: null,
  });
  expect((await get('/api/issues?status=resolved')).total).toBe(0);

  await db.query("update site set scope = 'pizzas only' where id = ?", siteId);
  expect(await get(`/api/issues/${issueId}`)).toMatchObject({
    id: issueId, kind: 'validation', status: 'open', siteId, siteName: 'web', siteScope: 'pizzas only',
  });
});

test('unknown routes 404, and the feed format reference is served as markdown', async () => {
  expect((await fetch(`${base}/api/nope`)).status).toBe(404);
  expect((await fetch(`${base}/sites/1`)).status).toBe(404);
  const doc = await fetch(`${base}/api/docs/feed-format`);
  expect(doc.headers.get('content-type')).toMatch(/^text\/markdown/);
  expect(await doc.text()).toMatch(/^# /);
});

const patch = async (path: string, body: object) => {
  const res = await fetch(base + path, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
};
const post = async (path: string, body?: object) => {
  const res = await fetch(base + path, {
    method: 'POST',
    ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: (await res.json()) as any };
};

async function extraIssue(n: number): Promise<number> {
  const [u] = await db.query<any[]>(
    "insert into url (site_id, type, url, hash, status) values (?, 'product', ?, ?, 2) returning id",
    siteId, `https://web.test/x${n}`, sha1(`https://web.test/x${n}`)
  );
  const [i] = await db.query<any[]>("insert into issue (url_id, kind, detail) values (?, 'validation', 'x') returning id", u.id);
  return Number(i.id);
}

test('open problems: one per site, page type and kind, represented by its earliest open issue', async () => {
  const [a, b] = [await extraIssue(1), await extraIssue(2)];
  await db.query("update issue set status = 'triaged' where id = ?", b);
  const [seed] = await db.query<any[]>("select id from url where url = 'https://web.test/'");
  const [blocked] = await db.query<any[]>("insert into issue (url_id, kind, detail) values (?, 'blocked', 'refused') returning id", seed.id);
  await db.query("update site set scope = 'pizzas only' where id = ?", siteId);

  const { problems } = await get('/api/problems');
  expect(problems).toEqual([
    expect.objectContaining({ issueId: issueId, kind: 'validation', open: 2, url: { id: productUrlId, url: 'https://web.test/p', type: 'product' } }),
    expect.objectContaining({ issueId: Number(blocked.id), kind: 'blocked', detail: 'refused', open: 1 }),
  ]);
  expect(problems[0].site).toEqual({ id: siteId, name: 'web', scope: 'pizzas only' });
  expect(problems.map((p: any) => p.issueId)).not.toContain(a);
});

test('crawler status, url reset and rescrape endpoints', async () => {
  const { crawlers } = await get('/api/crawlers');
  expect(crawlers).toEqual([
    expect.objectContaining({ siteId, siteName: 'web', running: false, runId: null, lastStatus: null }),
  ]);

  expect(await post(`/api/sites/${siteId}/reset-urls`, { dry: true })).toMatchObject({ status: 200, body: { affected: 3 } });
  const queued = await post(`/api/urls/${productUrlId}/rescrape`, { mode: 'queue' });
  expect(queued.body).toEqual({ queued: true });
  const [u] = await db.query<any[]>('select status from url where id = ?', productUrlId);
  expect(u.status).toBe(0);

  expect(await post(`/api/urls/${productUrlId}/rescrape`, { mode: 'bogus' })).toMatchObject({ status: 400 });
  expect(await post('/api/crawlers/nope/start')).toMatchObject({ status: 404 });
  expect(await post(`/api/crawlers/${siteId}/stop`)).toMatchObject({ status: 409 });
  expect((await fetch(`${base}/api/crawlers/${siteId}/log`)).status).toBe(404);
});

test('crawl actions across every site: reset failed, recrawl, resume', async () => {
  await db.query('update url set status = -1 where id = ?', productUrlId);
  expect((await post('/api/crawlers/reset-failed', { dry: true })).body).toEqual({ affected: 1, siteIds: [siteId] });
  const [still] = await db.query<any[]>('select status from url where id = ?', productUrlId);
  expect(still.status).toBe(-1);

  const reset = await post('/api/crawlers/reset-failed', {});
  expect(reset.body).toMatchObject({ affected: 1, started: [{ siteId }] });
  const [idle] = await db.query<any[]>('select status from url where id = ?', productUrlId);
  expect(idle.status).toBe(0);

  // the stand-in crawl exits at once, leaving the idle url behind: a stopped crawl to resume
  await waitForCrawlEnd();
  expect((await post('/api/crawlers/resume', { dry: true })).body).toEqual({ sites: [{ siteId, urls: 1 }] });
  expect((await post('/api/crawlers/resume')).body).toMatchObject({ started: [{ siteId }] });
  await waitForCrawlEnd();

  expect((await post('/api/crawlers/recrawl', { dry: true })).body).toEqual({ affected: 2, siteIds: [siteId] });
  expect((await post('/api/crawlers/recrawl', {})).body).toMatchObject({ affected: 2, started: [{ siteId }] });
  const statuses = await db.query<any[]>('select status from url where site_id = ? order by id', siteId);
  expect(statuses.every((u) => u.status === 0)).toBe(true);
  await waitForCrawlEnd();
});

async function waitForCrawlEnd() {
  for (let i = 0; i < 100; i++) {
    const { crawlers } = await get('/api/crawlers');
    if (!crawlers[0].running) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('the crawl did not end');
}

test('PATCH /api/issues/:id is the human status override', async () => {
  const ignored = await patch(`/api/issues/${issueId}`, { status: 'ignored', note: 'known site bug' });
  expect(ignored).toMatchObject({ status: 200, body: { status: 'ignored', changed: true } });
  const [row] = await db.query<any[]>('select status, resolved_at, resolution from issue where id = ?', issueId);
  expect(row.status).toBe('ignored');
  expect(row.resolved_at).not.toBeNull();
  expect(row.resolution).toContain('[operator note] known site bug');

  const reopened = await patch(`/api/issues/${issueId}`, { status: 'open' });
  expect(reopened.body).toMatchObject({ status: 'open', changed: true });
  const [again] = await db.query<any[]>('select resolved_at, resolution from issue where id = ?', issueId);
  expect(again.resolved_at).toBeNull();
  expect(again.resolution).toContain('[operator note] known site bug');

  expect(await patch(`/api/issues/${issueId}`, { status: 'triaged' })).toMatchObject({ status: 400 });
  expect(await patch('/api/issues/999999', { status: 'open' })).toMatchObject({ status: 404 });
});

test('the issues that took a verdict follow the human override of the original', async () => {
  const [copyA, copyB] = [await extraIssue(1), await extraIssue(2)];
  await db.query("update issue set status = 'triaged', verdict = 'extractor_bug' where id in (?, ?, ?)", issueId, copyA, copyB);
  await db.query('update issue set same_as = ? where id in (?, ?)', issueId, copyA, copyB);
  const statuses = async () =>
    (await db.query<any[]>('select status from issue where id in (?, ?) order by id', copyA, copyB)).map((r) => r.status);

  const detail = await get(`/api/issues/${copyA}`);
  expect([detail.sameAs, detail.copies]).toEqual([issueId, 0]);
  expect((await get(`/api/issues/${issueId}`)).copies).toBe(2);

  expect((await patch(`/api/issues/${issueId}`, { status: 'resolved' })).body).toMatchObject({ copies: 2 });
  expect(await statuses()).toEqual(['resolved', 'resolved']);

  // a copy whose page failed again since has a newer issue: reopening leaves it settled
  const [u] = await db.query<any[]>('select url_id from issue where id = ?', copyB);
  await db.query("insert into issue (url_id, kind, detail) values (?, 'validation', 'again')", u.url_id);
  expect((await patch(`/api/issues/${issueId}`, { status: 'open' })).body).toMatchObject({ copies: 1 });
  expect(await statuses()).toEqual(['open', 'resolved']);

  // a copy someone settled on its own keeps its status
  await patch(`/api/issues/${copyA}`, { status: 'ignored' });
  expect((await patch(`/api/issues/${issueId}`, { status: 'resolved' })).body).toMatchObject({ copies: 0 });
  expect(await statuses()).toEqual(['ignored', 'resolved']);
});

test('price history is served newest-first and caps the report', async () => {
  const [variant] = await db.query<any[]>(
    "select v.id from product_variant v join product p on p.id = v.product_id where p.code = 'W1'");
  for (const [price, age] of [[11.11, '2 days'], [10.5, '1 day']] as const) {
    await db.query(
      `insert into variant_price (variant_id, observed_at, currency, price) values (?, now() - interval '${age}', 'AUD', ?)`,
      variant.id, price);
  }
  const data = await get(`/api/urls/${productUrlId}/data`);
  const history = data.products[0].variants[0].priceHistory;
  expect(history.map((h: any) => h.price)).toEqual([9.99, 10.5, 11.11]);
  expect(data.products[0].variants[0].lastPrice).toEqual(history[0]);
});

test('site categories come back flat with parent links and product counts', async () => {
  const [tilesUrl] = await db.query<any[]>(
    "insert into url (site_id, type, url, hash, status) values (?, 'category', 'https://web.test/tiles', ?, 2) returning id",
    siteId, sha1('https://web.test/tiles'));
  const [floorUrl] = await db.query<any[]>(
    "insert into url (site_id, type, url, hash, status) values (?, 'category', 'https://web.test/tiles/floor', ?, 2) returning id",
    siteId, sha1('https://web.test/tiles/floor'));
  const [tiles] = await db.query<any[]>(
    'insert into category (site_id, url_id, name) values (?, ?, ?) returning id', siteId, tilesUrl.id, 'Tiles');
  const [floor] = await db.query<any[]>(
    'insert into category (site_id, parent_id, url_id, name) values (?, ?, ?, ?) returning id',
    siteId, tiles.id, floorUrl.id, 'Floor');
  const [widget] = await db.query<any[]>("select id from product where code = 'W1'");
  await db.query('insert into product_category (product_id, category_id) values (?, ?)', widget.id, floor.id);

  const { categories } = await get(`/api/sites/${siteId}/categories`);
  expect(categories).toEqual([
    expect.objectContaining({ name: 'Tiles', parentId: null, products: 0, urlId: Number(tilesUrl.id) }),
    expect.objectContaining({ name: 'Floor', parentId: Number(tiles.id), products: 1, urlId: Number(floorUrl.id) }),
  ]);
});

test('the live check fetches the url now and extracts its JSON-LD product', async () => {
  const [live] = await db.query<any[]>(
    "insert into url (site_id, type, url, hash, status) values (?, 'product', ?, ?, 2) returning id",
    siteId, `${liveBase}/live`, sha1(`${liveBase}/live`));
  const check = await get(`/api/urls/${live.id}/live`);
  expect(check).toMatchObject({ httpStatus: 200, error: null });
  expect(check.product).toMatchObject({ name: 'Live Widget' });
  expect(check.product.variants[0]).toMatchObject({ price: 12.34, availability: 'in_stock' });

  const [dead] = await db.query<any[]>(
    "insert into url (site_id, type, url, hash, status) values (?, 'product', 'http://127.0.0.1:1/p', ?, 2) returning id",
    siteId, sha1('http://127.0.0.1:1/p'));
  expect((await get(`/api/urls/${dead.id}/live`)).error).toMatch(/ECONNREFUSED/);
});

test('a site catalogue lists products by category subtree, in listing order, with price ranges', async () => {
  const categoryUrl = async (path: string) =>
    (await db.query<any[]>(
      "insert into url (site_id, type, url, hash, status) values (?, 'category', ?, ?, 2) returning id",
      siteId, `https://web.test${path}`, sha1(`https://web.test${path}`)))[0].id;
  const [tiles] = await db.query<any[]>(
    "insert into category (site_id, url_id, name) values (?, ?, 'Tiles') returning id", siteId, await categoryUrl('/tiles'));
  const [floor] = await db.query<any[]>(
    "insert into category (site_id, parent_id, url_id, name) values (?, ?, ?, 'Floor') returning id",
    siteId, tiles.id, await categoryUrl('/tiles/floor'));
  const [widget] = await db.query<any[]>("select id from product where code = 'W1'");
  const [gadget] = await db.query<any[]>(
    "insert into product (site_id, code, name) values (?, 'G1', 'Gadget') returning id", siteId);
  await db.query(
    "insert into product_variant (product_id, code, price, compare_at_price, availability) values (?, 'a', 5, 8, 'out_of_stock'), (?, 'b', 7, null, 'in_stock')",
    gadget.id, gadget.id);
  await db.query('insert into product_category (product_id, category_id, position) values (?, ?, 1), (?, ?, 2)',
    widget.id, floor.id, gadget.id, floor.id);
  await db.query("insert into product (site_id, code, name) values (?, 'X1', 'Uncategorised')", siteId);

  const all = await get(`/api/sites/${siteId}/products`);
  expect(all.total).toBe(3);
  expect(all.rows.map((r: any) => r.name)).toEqual(['Gadget', 'Uncategorised', 'Widget']);

  // the parent category covers its children's products (by name: it lists none itself)
  const inTiles = await get(`/api/sites/${siteId}/products?categoryId=${tiles.id}`);
  expect(inTiles.rows.map((r: any) => r.code)).toEqual(['G1', 'W1']);
  // a listing keeps its own order
  const inFloor = await get(`/api/sites/${siteId}/products?categoryId=${floor.id}`);
  expect(inFloor.rows.map((r: any) => r.code)).toEqual(['W1', 'G1']);
  expect(inFloor.rows[1]).toMatchObject({ variants: 2, minPrice: 5, maxPrice: 7, onSale: true, inStock: 1 });

  const found = await get(`/api/sites/${siteId}/products?q=gadg`);
  expect(found.rows.map((r: any) => r.code)).toEqual(['G1']);
});

test('a product page bundles the product, its variants and the pages it came from', async () => {
  const [widget] = await db.query<any[]>("select id from product where code = 'W1'");
  const report = await get(`/api/products/${widget.id}`);
  expect(report.site).toEqual({ id: siteId, name: 'web', currency: 'AUD' });
  expect(report.product).toMatchObject({ code: 'W1', name: 'Widget', variants: [expect.objectContaining({ price: 9.99 })] });
  expect(report.urls).toEqual([{ id: productUrlId, url: 'https://web.test/p', type: 'product', status: 2 }]);
  expect((await fetch(`${base}/api/products/999999`)).status).toBe(404);
});

test('the feed downloads as one zip, categories before products', async () => {
  const res = await fetch(`${base}/api/sites/${siteId}/feed.zip`);
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toBe('application/zip');
  expect(res.headers.get('content-disposition')).toBe('attachment; filename="web-feed.zip"');
  const files = unzipSync(new Uint8Array(await res.arrayBuffer()));
  expect(Object.keys(files)).toEqual(['categories.csv', 'products.csv']);
  expect(strFromU8(files['categories.csv']).split('\n')[0]).toBe('product_type,description,image_link,sort_order');
  const products = strFromU8(files['products.csv']);
  expect(products.split('\n')[0]).toMatch(/^id,item_group_id,title,/);
  expect(products).toContain('W1,,Widget');
});

test('the sql console runs read-only queries and reports errors', async () => {
  const post = (body: unknown, type = 'application/json') =>
    fetch(`${base}/api/sql`, { method: 'POST', headers: { 'content-type': type }, body: JSON.stringify(body) });

  const ok = await post({ query: "select code, name from product where code = 'W1';" });
  expect(ok.status).toBe(200);
  expect(await ok.json()).toEqual({ columns: ['code', 'name'], rows: [{ code: 'W1', name: 'Widget' }], truncated: false });

  const write = await post({ query: "delete from product where code = 'W1'" });
  expect(write.status).toBe(400);
  expect((await write.json()).error).toMatch(/syntax error/);
  expect(await db.query("select 1 from product where code = 'W1'")).toHaveLength(1);

  expect((await post({ query: 'select nope' })).status).toBe(400);
  expect((await post({ query: 'select 1' }, 'text/plain')).status).toBe(415);

  const { tables } = await get('/api/sql/schema');
  expect(tables.product).toEqual(expect.arrayContaining([{ name: 'code', type: 'text', nullable: false }]));
});
