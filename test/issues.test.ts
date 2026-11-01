import Crawler from '../src/core/crawler';
import { CrawlerDatabase } from '../src/core/database';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Response } from '../src/core/fetch';
import { recordIssue } from '../src/core/issues';
import { SiteUrl, UrlStatus } from '../src/core/models';
import { domainTools } from '../src/mcp/tools';

const connection = {
  dialect: 'postgres' as const,
  connection: { host: '127.0.0.1', port: 5434, user: 'admin', password: 'secret', database: 'jscrawl_test' },
};
const htmlDir = mkdtempSync(join(tmpdir(), 'jscrawl-validate-'));
const config = { database: connection.connection, store: { html: htmlDir } } as any;

let db: CrawlerDatabase;
let crawler: Crawler;
let resolveIssue: ReturnType<typeof domainTools>[number];
let site: { id: number; name: string };
let seed: SiteUrl;

const q = (sql: string, ...args: unknown[]) => db.query<any[]>(sql, ...args);

beforeAll(async () => {
  db = new CrawlerDatabase(connection);
  await db.buildSchema();
  resolveIssue = domainTools({ db: db as any, config, cwd: process.cwd(), jscrawlUrl: 'http://127.0.0.1:1', imagedUrl: 'http://127.0.0.1:1' }).find(
    (t) => t.name === 'resolveIssue'
  )!;
});
afterAll(async () => {
  await db.end();
  rmSync(htmlDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await db.zap();
  const c = db.table('crawler').append({ name: 'shop' });
  const s = db.table('site').append({ name: 'shop', crawler: c, currency: 'AUD' });
  db.table('url').append({ site: s, url: 'https://shop.test/', hash: 'seed', type: 'seed' });
  await db.flush();
  db.clear();
  await db.init('shop');
  crawler = new Crawler(db, config);
  site = { id: db.site.id, name: db.site.name };
  seed = (await db.table('url').select({ site: '*' }))[0] as unknown as SiteUrl;
});

/** Flushes a bare url row and returns its id. */
async function makeUrl(url: string, type: string): Promise<number> {
  const rec = db.addUrl(url, type, null);
  await db.flush();
  const id = Number((rec as any).id);
  db.clear();
  return id;
}

/** Flushes a product (with optional fields) linked to a new product url; returns the url id. */
async function makeProduct(opts: { name?: string; price?: number; category?: boolean; image?: boolean }): Promise<number> {
  const urlId = await makeUrl('https://shop.test/p/' + Math.random().toString(36).slice(2), 'product');
  const category = opts.category ? db.addCategory('Tiles', '/tiles', seed, null) : null;
  const product = db.addProduct(
    { code: 'P' + urlId, ...(opts.name ? { name: opts.name } : {}) },
    { detailed: true, ...(category ? { category } : {}) }
  );
  db.addVariant(product, opts.price !== undefined ? { price: opts.price } : {});
  if (opts.image) db.addProductImage(product, 'https://shop.test/a.jpg');
  db.addProductUrl(product, urlId, null);
  await db.flush();
  db.clear();
  return urlId;
}

const asUrl = (id: number, type: string): SiteUrl =>
  ({ id, url: 'https://shop.test/x', type, data: null, status: 2, version: 1, site }) as SiteUrl;

describe('recordIssue', () => {
  test('records an open issue on the url', async () => {
    const urlId = await makeUrl('https://shop.test/p1', 'product');
    await recordIssue(db, { id: urlId }, 'validation', 'no variant has a positive price');
    const issues = await q('select * from issue');
    expect(issues.map((i) => [i.kind, i.status, Number(i.url_id), i.detail])).toEqual([
      ['validation', 'open', urlId, 'no variant has a positive price'],
    ]);
  });

  test('is idempotent per open issue', async () => {
    const urlId = await makeUrl('https://shop.test/p1', 'product');
    await recordIssue(db, { id: urlId }, 'validation', 'first');
    await recordIssue(db, { id: urlId }, 'validation', 'second');
    expect((await q('select detail from issue')).map((i) => i.detail)).toEqual(['second']);
  });

  test('a page failing again while its issue is triaged adds no issue', async () => {
    const urlId = await makeUrl('https://shop.test/p1', 'product');
    await recordIssue(db, { id: urlId }, 'validation', 'first');
    await q(`update issue set status = 'triaged', verdict = 'extractor_bug', resolution = 'r'`);
    await recordIssue(db, { id: urlId }, 'validation', 'second');
    expect((await q('select * from issue')).map((i) => [i.status, i.detail])).toEqual([['triaged', 'first']]);

    // once a human settles it, a new failure is a new issue
    await q(`update issue set status = 'resolved'`);
    await recordIssue(db, { id: urlId }, 'validation', 'third');
    expect(await q("select * from issue where status = 'open'")).toHaveLength(1);
  });

  test('an issue repeating a triaged one takes its verdict at once; another kind or page type does not', async () => {
    const first = await makeUrl('https://shop.test/t1', 'product');
    await recordIssue(db, { id: first }, 'validation', 'the fetched page has 7 spec-like table(s)');
    await q(`update issue set status = 'triaged', verdict = 'extractor_bug', resolution = 'use .specs table'`);
    const second = await makeUrl('https://shop.test/t2', 'product');
    // worded differently, but the same site, page type and kind
    await recordIssue(db, { id: second }, 'validation', 'product has no images');

    const [original] = await q('select id from issue where url_id = ?', first);
    const [row] = await q('select * from issue where url_id = ?', second);
    expect([row.status, row.verdict, row.resolution, Number(row.same_as)]).toEqual([
      'triaged', 'extractor_bug', null, Number(original.id),
    ]);
    // a third copies the original, not the copy it may have matched
    const third = await makeUrl('https://shop.test/t3', 'product');
    await recordIssue(db, { id: third }, 'validation', 'something else');
    const [copy] = await q('select same_as from issue where url_id = ?', third);
    expect(Number(copy.same_as)).toBe(Number(original.id));

    await recordIssue(db, { id: second }, 'scrape_failed', 'Unrecognised template');
    const listing = await makeUrl('https://shop.test/c1', 'category');
    await recordIssue(db, { id: listing }, 'validation', 'category page yielded no product urls');
    expect((await q("select kind from issue where status = 'open' order by id")).map((i) => i.kind)).toEqual([
      'scrape_failed', 'validation',
    ]);
  });
});

describe('checkExpectations', () => {
  test("a complete crawl short of its crawler's expectations raises one acceptance issue on the seed", async () => {
    for (const price of [10, 12, undefined]) await makeProduct({ name: 'Pizza', price, image: true });
    db.site.expect = { products: [40, 70], fields: ['price', 'image'] };
    const shortfalls = await crawler.checkExpectations();
    expect(shortfalls).toEqual([
      '3 products were saved; the crawler expects 40-70',
      '1 of 3 products (33%) have no price; the crawler requires it on 95%',
    ]);
    const [issue] = await q('select * from issue');
    expect([issue.kind, Number(issue.url_id), issue.detail]).toEqual(['acceptance', Number(seed.id), shortfalls.join('; ')]);

    // met: nothing raised
    await q('delete from issue');
    db.site.expect = { products: [1, 10], fields: ['image'] };
    expect(await crawler.checkExpectations()).toEqual([]);
    expect(await q('select * from issue')).toHaveLength(0);
  });
});

describe('checkRegression', () => {
  test('a complete crawl worse than the last raises one regression issue on the seed', async () => {
    for (let n = 0; n < 12; n++) await makeProduct({ name: `Pizza ${n}`, price: 10 + n, image: true });
    // the first complete crawl only records the state
    expect(await crawler.checkRegression()).toEqual([]);
    expect(await q('select * from crawl_snapshot')).toHaveLength(1);

    // the next one lost every price
    await q('update product_variant set price = null');
    expect(await crawler.checkRegression()).toEqual(['products with a price fell from 100% to 0%']);
    const [issue] = await q('select * from issue');
    expect([issue.kind, Number(issue.url_id)]).toEqual(['regression', Number(seed.id)]);
  });
});

describe('validate', () => {
  test('a complete product passes', async () => {
    const urlId = await makeProduct({ name: 'Thing', price: 10, category: true, image: true });
    expect(await crawler.validate(asUrl(urlId, 'product'))).toEqual([]);
  });

  test('flags a product missing name, price and image', async () => {
    const urlId = await makeProduct({});
    const issues = await crawler.validate(asUrl(urlId, 'product'));
    expect(issues).toEqual(
      expect.arrayContaining(['product has no name', 'no variant has a positive price', 'product has no images'])
    );
    // Category membership depends on which listing has been crawled, so it is
    // coverage's question after the fact, not this page's.
    expect(issues).not.toContain('product is not in any category');
  });

  test('flags a product page whose snapshot has spec tables but no saved attributes', async () => {
    const urlId = await makeProduct({ name: 'Spec', price: 5, category: true, image: true });
    const rows = '<tr><th>Key</th><td>Value</td></tr>'.repeat(4);
    writeFileSync(join(htmlDir, `${urlId}.0`), `<html><body><table>${rows}</table></body></html>`);
    const issues = await crawler.validate({ ...asUrl(urlId, 'product'), version: 0 });
    expect(issues).toEqual([expect.stringMatching(/spec-like table/)]);
  });

  test('flags a page whose only attributes are variant axes while the snapshot has td/td spec tables', async () => {
    const urlId = await makeUrl('https://shop.test/axis-only', 'product');
    const product = db.addProduct({ code: 'AX', name: 'Axis' }, { detailed: true, category: db.addCategory('Tiles', '/tiles', seed, null) });
    const { values } = db.addAttribute(product, { name: 'Size', values: ['S', 'L'] });
    db.addVariant(product, { price: 7 }, [values[0]]);
    db.addProductImage(product, 'https://shop.test/a.jpg');
    db.addProductUrl(product, urlId, null);
    await db.flush();
    db.clear();
    const rows = '<tr><td>Material</td><td>Brass</td></tr>'.repeat(4);
    writeFileSync(join(htmlDir, `${urlId}.0`), `<html><body><table>${rows}</table></body></html>`);
    const issues = await crawler.validate({ ...asUrl(urlId, 'product'), version: 0 });
    expect(issues).toEqual([expect.stringMatching(/spec-like table/)]);
  });

  test('does not flag spec tables when spec attributes were saved', async () => {
    const urlId = await makeUrl('https://shop.test/with-specs', 'product');
    const product = db.addProduct({ code: 'SP', name: 'Specs' }, { detailed: true, category: db.addCategory('Tiles', '/tiles', seed, null) });
    db.addAttribute(product, { groupName: 'Product Information', name: 'Material', values: ['Brass'] });
    db.addVariant(product, { price: 7 });
    db.addProductImage(product, 'https://shop.test/a.jpg');
    db.addProductUrl(product, urlId, null);
    await db.flush();
    db.clear();
    const rows = '<tr><td>Material</td><td>Brass</td></tr>'.repeat(4);
    writeFileSync(join(htmlDir, `${urlId}.0`), `<html><body><table>${rows}</table></body></html>`);
    expect(await crawler.validate({ ...asUrl(urlId, 'product'), version: 0 })).toEqual([]);
  });

  test('a label repeated on every card is not a spec list', async () => {
    const urlId = await makeProduct({ name: 'Rug', price: 5, category: true, image: true });
    const card = '<dl><dt>Unit price</dt><dd>/ per</dd></dl>';
    writeFileSync(join(htmlDir, `${urlId}.0`), `<html><body>${card.repeat(20)}</body></html>`);
    expect(await crawler.validate({ ...asUrl(urlId, 'product'), version: 0 })).toEqual([]);

    const specs = ['Pile', 'Backing', 'Size', 'Care', 'Origin', 'Weight'].map((label) => `<dt>${label}</dt><dd>x</dd>`).join('');
    writeFileSync(join(htmlDir, `${urlId}.0`), `<html><body><dl>${specs}</dl></body></html>`);
    expect(await crawler.validate({ ...asUrl(urlId, 'product'), version: 0 })).toEqual([
      expect.stringMatching(/6 distinct dt\/dd labels/),
    ]);
  });

  test('flags a product page that saved no product', async () => {
    const urlId = await makeUrl('https://shop.test/empty', 'product');
    expect(await crawler.validate(asUrl(urlId, 'product'))).toEqual(['no product was saved for this product page']);
  });

  test('flags a category page that yielded no product urls', async () => {
    const urlId = await makeUrl('https://shop.test/c', 'category');
    expect(await crawler.validate(asUrl(urlId, 'category'))).toEqual(['category page yielded no product urls']);
  });

  test('a page the scraper vouched for via url.data is not flagged, whatever its type', async () => {
    const empty = await makeUrl('https://shop.test/c-empty', 'category');
    const category = asUrl(empty, 'category');
    category.data = 'empty-collection';
    expect(await crawler.validate(category)).toEqual([]);

    // A CMS page on a flat-slug catalogue: queued as a product because its url
    // looks like one, and vouched for once the page said otherwise.
    const cms = await makeUrl('https://shop.test/careers', 'product');
    const product = asUrl(cms, 'product');
    product.data = 'cms page: carries no catalogue record';
    expect(await crawler.validate(product)).toEqual([]);
  });
});

/** A crawler with a stubbed network fetch and a controllable product scrape. */
class TestCrawler extends Crawler {
  scrapeImpl: () => Promise<void> = async () => {};
  statusCode = 200;
  protected async fetchPage(url: string): Promise<Response> {
    const now = new Date();
    return new Response({
      url,
      requestUrl: url,
      statusCode: this.statusCode,
      headers: { 'content-type': 'text/html' },
      httpVersion: '1.1',
      body: Buffer.from('<html><body></body></html>'),
      fetchStart: now,
      fetchEnd: now,
    });
  }
  async scrapeProduct(): Promise<void> {
    return this.scrapeImpl();
  }
  async scrapeCategory(): Promise<void> {
    return this.scrapeImpl();
  }
}

describe('process() issues', () => {
  let testCrawler: TestCrawler;

  beforeEach(() => {
    testCrawler = new TestCrawler(db, config);
    testCrawler.logger = { info() {}, warn() {}, error() {} } as any;
  });

  async function productUrl(): Promise<SiteUrl> {
    const rec = db.addUrl('https://shop.test/pp/' + Math.random().toString(36).slice(2), 'product', null);
    await db.flush();
    const id = Number((rec as any).id);
    db.clear();
    return (await db.getUrl(String(id))) as unknown as SiteUrl;
  }

  test('a scrape that throws is recorded as scrape_failed', async () => {
    const url = await productUrl();
    testCrawler.scrapeImpl = async () => {
      throw new Error('no product data on page');
    };
    await testCrawler.process(url, { scrape: true });

    const [u] = await q('select status from url where id = ?', url.id);
    expect(u.status).toBe(UrlStatus.ScrapeFailed);
    const issues = await q('select * from issue');
    expect(issues).toHaveLength(1);
    expect([issues[0].kind, issues[0].detail]).toEqual(['scrape_failed', 'no product data on page']);
  });

  test('scraped data that fails validation is recorded', async () => {
    const url = await productUrl();
    testCrawler.scrapeImpl = async () => {
      const product = db.addProduct({ code: 'BAD' }, { detailed: true });
      db.addVariant(product, {}); // no price
      db.addProductUrl(product, url.id, null);
    };
    await testCrawler.process(url, { scrape: true });

    const [u] = await q('select status from url where id = ?', url.id);
    expect(u.status).toBe(UrlStatus.Done);
    const issues = await q('select * from issue');
    expect(issues).toHaveLength(1);
    expect(issues[0].kind).toBe('validation');
    expect(issues[0].detail).toMatch(/positive price/);
  });

  test('page fetches failing 20 in a row stop the crawl and raise one blocked issue on the seed', async () => {
    testCrawler.statusCode = 403;
    for (let n = 0; n < 19; n++) await testCrawler.process(await productUrl());
    // a page that loads, or is simply gone, ends the run
    testCrawler.statusCode = 404;
    await testCrawler.process(await productUrl());
    testCrawler.statusCode = 403;
    for (let n = 0; n < 19; n++) await testCrawler.process(await productUrl());
    expect([testCrawler.stop.requested, await q('select * from issue')]).toEqual([false, []]);

    testCrawler.statusCode = 429;
    await testCrawler.process(await productUrl());
    expect(testCrawler.stop.requested).toBe(true);
    expect(testCrawler.refusals.blocked).toMatch(/^the last 20 page fetches failed \(19 × HTTP 403, 1 × HTTP 429\)/);
    await testCrawler.process(await productUrl());
    const issues = await q('select * from issue');
    expect(issues.map((i) => [i.kind, Number(i.url_id)])).toEqual([['blocked', Number(seed.id)]]);
  });

  test('valid scraped data raises no issue', async () => {
    const url = await productUrl();
    testCrawler.scrapeImpl = async () => {
      const category = db.addCategory('Tiles', '/tiles', seed, null);
      const product = db.addProduct({ code: 'GOOD', name: 'Good Tile' }, { detailed: true, category });
      db.addVariant(product, { price: 12 });
      db.addProductImage(product, 'https://shop.test/a.jpg');
      db.addProductUrl(product, url.id, null);
    };
    await testCrawler.process(url, { scrape: true });

    expect(await q('select * from issue')).toHaveLength(0);
  });

  test('a confirmed-empty category vouched via url.data persists the note and raises no issue', async () => {
    const rec = db.addUrl('https://shop.test/empty-c', 'category', null);
    await db.flush();
    const id = Number((rec as any).id);
    db.clear();
    const url = (await db.getUrl(String(id))) as unknown as SiteUrl;
    testCrawler.scrapeImpl = async () => {
      url.data = 'empty-collection';
    };
    await testCrawler.process(url, { scrape: true });

    const [row] = await q('select status, data from url where id = ?', id);
    expect(row.status).toBe(UrlStatus.Done);
    expect(row.data).toBe('empty-collection');
    expect(await q('select * from issue')).toHaveLength(0);
  });
});

describe('resolveIssue', () => {
  const ctx = { cwd: process.cwd() };

  /** Escalates a fresh url and returns the open issue's id. */
  async function openIssue(): Promise<number> {
    const urlId = await makeUrl('https://shop.test/r/' + Math.random().toString(36).slice(2), 'product');
    await recordIssue(db, { id: urlId }, 'validation', 'no variant has a positive price');
    const [issue] = await q('select * from issue');
    return Number(issue.id);
  }

  test('records a verdict and moves the issue to triaged', async () => {
    const id = await openIssue();
    const out = await resolveIssue.execute(
      { issue: id, verdict: 'extractor_bug', resolution: 'price selector wrong; use .product-price', status: 'triaged' },
      ctx
    );
    expect(out).toBe(`Issue ${id} set to triaged (extractor_bug).`);
    const [row] = await q('select * from issue where id = ?', id);
    expect([row.status, row.verdict, row.resolution]).toEqual([
      'triaged',
      'extractor_bug',
      'price selector wrong; use .product-price',
    ]);
    expect(row.resolved_at).toBeNull();
  });

  test('a resolved issue records resolved_at', async () => {
    const id = await openIssue();
    await resolveIssue.execute({ issue: id, verdict: 'correct', resolution: 'data matches the page', status: 'resolved' }, ctx);
    const [row] = await q('select * from issue where id = ?', id);
    expect(row.status).toBe('resolved');
    expect(row.resolved_at).not.toBeNull();
  });

  test('rejects an invalid verdict or status', async () => {
    const id = await openIssue();
    await expect(resolveIssue.execute({ issue: id, verdict: 'bogus', resolution: 'x' }, ctx)).rejects.toThrow(/verdict must be/);
    await expect(
      resolveIssue.execute({ issue: id, verdict: 'correct', resolution: 'x', status: 'bogus' }, ctx)
    ).rejects.toThrow(/status must be/);
  });

  test('settles the open issues waiting on the same problem', async () => {
    const urls: number[] = [];
    for (const path of ['w1', 'w2', 'w3']) urls.push(await makeUrl(`https://shop.test/${path}`, 'product'));
    for (const [i, id] of urls.entries()) {
      await recordIssue(db, { id }, 'scrape_failed', `failure number ${i} on https://shop.test/w${i + 1}`);
    }
    const listing = await makeUrl('https://shop.test/c', 'category');
    await recordIssue(db, { id: listing }, 'scrape_failed', 'Unrecognised template');
    const [first] = await q('select id from issue order by id limit 1');
    const out = await resolveIssue.execute(
      { issue: Number(first.id), verdict: 'extractor_bug', resolution: 'a new template', status: 'triaged' },
      ctx
    );
    expect(out).toMatch(/2 other issue\(s\) with the same problem got the same verdict/);
    const rows = await q('select status, verdict, resolution, same_as from issue order by id');
    expect(rows.map((r) => [r.status, r.verdict])).toEqual([
      ['triaged', 'extractor_bug'], ['triaged', 'extractor_bug'], ['triaged', 'extractor_bug'], ['open', null],
    ]);
    expect([rows[1].resolution, Number(rows[1].same_as)]).toEqual([null, Number(first.id)]);

    // a new verdict on the original reaches its triaged copies too
    await resolveIssue.execute({ issue: Number(first.id), verdict: 'correct', resolution: 'fine after all', status: 'resolved' }, ctx);
    const after = await q('select status, verdict from issue order by id');
    expect(after.slice(0, 3).map((r) => [r.status, r.verdict])).toEqual([
      ['resolved', 'correct'], ['resolved', 'correct'], ['resolved', 'correct'],
    ]);
  });

  test('will not overwrite a resolved issue', async () => {
    const id = await openIssue();
    await resolveIssue.execute({ issue: id, verdict: 'correct', resolution: 'ok', status: 'resolved' }, ctx);
    await expect(resolveIssue.execute({ issue: id, verdict: 'stale', resolution: 'changed' }, ctx)).rejects.toThrow(
      /No open or triaged issue/
    );
  });
});
