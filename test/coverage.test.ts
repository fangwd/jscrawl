import { coverage, coverageKey, groupByShape, urlShape } from '../src/core/coverage';
import { CrawlerDatabase } from '../src/core/database';
import { SiteUrl } from '../src/core/models';
import { fetching, sitemapXml } from './support/fakeFetch';

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

const ORIGIN = 'https://shop.test';

let db: CrawlerDatabase;

beforeAll(async () => {
  db = new CrawlerDatabase(connection);
  await db.buildSchema();
});

afterAll(() => db.end());

beforeEach(async () => {
  await db.zap();
  const crawler = db.table('crawler').append({ name: 'shop' });
  const site = db.table('site').append({ name: 'shop', crawler, currency: 'AUD' });
  db.table('url').append({ site, url: `${ORIGIN}/`, hash: 'seed', type: 'seed' });
  await db.flush();
  db.clear();
  await db.init('shop');
});

test('urls compare by host and path, and shapes group by their first segment', () => {
  expect(coverageKey('https://www.Shop.test/a/b/?x=1#frag')).toBe('shop.test/a/b');
  expect(coverageKey('https://shop.test/')).toBe('shop.test/');
  expect(coverageKey('not a url')).toBeUndefined();

  expect(urlShape('https://shop.test/manhattan-white-matt')).toBe('/<slug>');
  expect(urlShape('https://shop.test/tiles/flooring/porcelain')).toBe('/tiles/*/*');
  expect(urlShape('https://shop.test/')).toBe('/');

  expect(groupByShape(['https://shop.test/a', 'https://shop.test/b', 'https://shop.test/x/y'])).toEqual([
    { shape: '/<slug>', count: 2, samples: ['/a', '/b'] },
    { shape: '/x/*', count: 1, samples: ['/x/y'] },
  ]);
});

test('the report names sitemap urls never queued and pages that contradict their type', async () => {
  // The seed row's hash is a fixture, not sha1 of its url, so select it directly.
  const [seedUrl] = (await db.table('url').select({ site: '*' }, { where: { type: 'seed' } })) as unknown as SiteUrl[];
  db.addUrl(`${ORIGIN}/good-product`, 'product', null);
  db.addUrl(`${ORIGIN}/empty-product`, 'product', null);
  db.addUrl(`${ORIGIN}/broken-product`, 'product', null);
  db.addCategory('Flooring', '/tiles/flooring', seedUrl, null);
  await db.flush();
  db.clear();

  const good = await db.getUrl(`${ORIGIN}/good-product`);
  const product = db.addProduct({ code: 'P1' }, { detailed: true });
  db.addProductUrl(product, good.id, null);
  await db.flush();
  db.clear();

  await db.table('url').update({ status: 2 }, { id: good.id });
  await db.table('url').update({ status: 2 }, { id: (await db.getUrl(`${ORIGIN}/empty-product`)).id });
  await db.table('url').update({ status: -2 }, { id: (await db.getUrl(`${ORIGIN}/broken-product`)).id });
  await db.table('url').update({ status: 2 }, { id: (await db.getUrl(`${ORIGIN}/tiles/flooring`)).id });

  const report = await coverage(db, 'shop', {
    fetch: fetching({
      [`${ORIGIN}/robots.txt`]: `Sitemap: ${ORIGIN}/sitemap.xml\n`,
      [`${ORIGIN}/sitemap.xml`]: sitemapXml(ORIGIN, [
        '/good-product',
        '/empty-product',
        '/broken-product',
        '/tiles/flooring',
        '/tiles/stone',
        '/missed-a',
        '/missed-b',
      ]),
    }),
  });

  expect(report!.queued).toEqual({
    total: 5,
    scraped: 3,
    failed: 1,
    disallowed: 0,
    vouched: 0,
    byType: { seed: 1, product: 3, category: 1 },
  });
  expect(report!.sitemaps.files).toEqual([
    { url: `${ORIGIN}/sitemap.xml`, urls: 7, byType: { product: 3, category: 1 }, missing: 3 },
  ]);
  expect(report!.sitemaps).toMatchObject({ urls: 7, matched: 4, missing: 3 });

  expect(report!.unqueued).toEqual([
    { shape: '/<slug>', count: 2, samples: ['/missed-a', '/missed-b'] },
    { shape: '/tiles/*', count: 1, samples: ['/tiles/stone'] },
  ]);
  // Only the seed: every catalogue url the crawler queued is one the site lists.
  expect(report!.unlisted).toEqual([{ shape: '/', count: 1, samples: ['/'] }]);

  expect(report!.suspects).toEqual([
    {
      label: 'product page scraped, saved no product and was not vouched for',
      count: 1,
      samples: ['/empty-product'],
    },
    {
      label: 'product page failed (type wrong, or extractor/fetch bug)',
      count: 1,
      samples: ['/broken-product (scrape failed)'],
    },
    {
      label: 'product in no category (the listing that carries it may not be crawled yet)',
      count: 1,
      samples: ['/good-product'],
    },
    {
      label: 'category page scraped, holds no products and was not vouched for (may be a landing page)',
      count: 1,
      samples: ['/tiles/flooring'],
    },
  ]);
});

test('a page the scraper vouched for is not a suspect', async () => {
  // A CMS page on a flat-slug catalogue: queued as a product because its url
  // looks like one, scraped, found to carry nothing, and vouched for.
  db.table('url').append({
    site: db.site.id,
    url: 'https://shop.test/careers',
    hash: 'careers',
    type: 'product',
    status: 2,
    data: 'cms page: no catalogue record',
  });
  await db.flush();
  db.clear();

  const report = await coverage(db, 'shop', { fetch: fetching({}) });
  expect(report!.queued.vouched).toBe(1);
  expect(report!.suspects[0]).toMatchObject({ count: 0, samples: [] });
});

test('a site without a sitemap still reports its suspects', async () => {
  const report = await coverage(db, 'shop', { fetch: fetching({}) });
  expect(report!.sitemaps).toEqual({ files: [], urls: 0, matched: 0, missing: 0 });
  expect(report!.unqueued).toEqual([]);
  expect(report!.suspects.every((suspect) => suspect.count === 0)).toBe(true);
});

test('the report carries the scope the crawl keeps to', async () => {
  expect((await coverage(db, 'shop', { fetch: fetching({}) }))!.site.scope).toBeNull();
  await db.query("update site set scope = 'pizzas only' where name = 'shop'");
  expect((await coverage(db, 'shop', { fetch: fetching({}) }))!.site.scope).toBe('pizzas only');
});

test('an unknown site reports nothing', async () => {
  expect(await coverage(db, 'nope', { fetch: fetching({}) })).toBeNull();
});
