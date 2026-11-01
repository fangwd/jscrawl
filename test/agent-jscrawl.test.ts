import { execFile } from 'child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { createServer, Server } from 'http';
import { AddressInfo } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';
import { promisify } from 'util';
import { Database } from 'sqlex';
import { sha1 } from '../src/core/utils';
import { domainTools } from '../src/mcp/tools';
import { Response } from '../src/core/fetch';
import { registerSite } from '../src/core/register';

const connectionInfo = { host: '127.0.0.1', port: 5434, user: 'admin', password: 'secret', database: 'jscrawl_test' };
const db = new Database({
  dialect: 'postgres',
  connection: connectionInfo,
});
const fixtureSitesDir = mkdtempSync(join(process.cwd(), 'test/fixtures/tool-crawlers-'));
const config = { database: { dialect: 'postgres', connection: connectionInfo }, store: {}, sites: { dir: fixtureSitesDir } } as any;
const tools = domainTools({ db, config, cwd: process.cwd(), jscrawlUrl: 'http://127.0.0.1:3120', imagedUrl: 'http://127.0.0.1:1' });
const named = (name: string) => tools.find((t) => t.name === name)!;
const webfetch = named('webfetch');
const html = named('html');
const sql = named('sql');
const inspectUrl = named('inspectUrl');
const scrapePreviewTool = named('scrapePreview');
const dryRunTool = named('dryRun');
const dbSchemaTool = named('dbSchema');
const cwd = mkdtempSync(join(tmpdir(), 'jscrawl-tools-'));
const page = readFileSync('test/fixtures/beaumont-tiles-product.html');
let server: Server;
let base: string;
let flakyHits = 0;

beforeAll(async () => {
  writeFileSync(join(fixtureSitesDir, 'tool-site.ts'),
    readFileSync('skills/new-site/template.ts', 'utf8').replaceAll("from '../src/core/", `from '${process.cwd()}/src/core/`));
  server = createServer((req, res) => {
    if (req.url === '/old') res.writeHead(301, { location: '/tiles' }).end();
    else if (req.url === '/json') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({ products: [{ id: 1, title: 'Thing', price: 9.99 }], count: 1 })
      );
    } else if (req.url === '/flaky') {
      flakyHits++;
      if (flakyHits === 1) res.writeHead(429).end('slow down');
      else res.writeHead(200, { 'content-type': 'text/html' }).end(page);
    } else res.writeHead(200, { 'content-type': 'text/html' }).end(page);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.close();
  await db.end();
  rmSync(fixtureSitesDir, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

test('webfetch shows the response, its JSON-LD, and saves fixtures', async () => {
  const html = await webfetch.execute({ url: `${base}/old`, saveTo: 'page.html' }, { cwd });
  expect(html).toMatch(new RegExp(`^HTTP 200 GET ${base}/tiles\ncontent-type: text/html\nsaved ${page.length} bytes to ${join(cwd, 'page.html')}\ngzip snapshot estimate: \\d+ bytes/page \\(body only\\)\n\n<!--`));
  expect(readFileSync(join(cwd, 'page.html'))).toEqual(page);

  const structured = await webfetch.execute({ url: base, format: 'jsonld' }, { cwd });
  expect(JSON.parse(structured.slice(structured.indexOf('\n\n')))[0]['@type']).toBe('BreadcrumbList');
});

test('html queries a saved page with CSS selectors', async () => {
  const file = 'test/fixtures/beaumont-tiles-product.html';
  const cwdRepo = process.cwd();
  expect(await html.execute({ file, selector: '.breadcrumbs li' }, { cwd: cwdRepo })).toBe('2 matches for .breadcrumbs li\n[1] Home\n[2] Tiles');
  expect(await html.execute({ file, selector: '.breadcrumbs a', attr: 'href' }, { cwd: cwdRepo })).toBe(
    '1 matches for .breadcrumbs a\n[1] https://www.beaumont-tiles.com.au/'
  );
  expect(await html.execute({ file, selector: 'li.category9', output: 'html' }, { cwd: cwdRepo })).toMatch(/\[1\] <li class="item category9">/);
  expect(await html.execute({ file, search: 'CATEGORY9' }, { cwd: cwdRepo })).toMatch(
    /^1 matches for "CATEGORY9"\n\[1\] ….*<li class="item category9"> <strong>Tiles<\/strong>/
  );
});

test('sql returns rows and refuses writes', async () => {
  expect(await sql.execute({ query: "select 1 as one, 'a'::text as cast" }, { cwd })).toBe('{"one":1,"cast":"a"}\n(1 rows)');
  await expect(sql.execute({ query: "insert into crawler (name) values ('x')" }, { cwd })).rejects.toThrow(/syntax error/);
  await expect(sql.execute({ query: 'drop table url' }, { cwd })).rejects.toThrow(/syntax error/);
});

test('sql cannot disable read-only mode or escape the transaction with multiple statements', async () => {
  await expect(sql.execute({ query: 'set transaction read write' }, { cwd })).rejects.toThrow();
  await expect(sql.execute({ query: 'commit; select 1' }, { cwd })).rejects.toThrow();
  await expect(sql.execute({ query: "select set_config('transaction_read_only', 'off', true)" }, { cwd })).rejects.toThrow();
  expect(await sql.execute({ query: "select 'a;b' as value;" }, { cwd })).toBe('{"value":"a;b"}\n(1 rows)');
  await expect(sql.execute({ query: 'select 1) as escaped; commit; select 2 --' }, { cwd })).rejects.toThrow();
  expect(await sql.execute({ query: 'with sample as (select 2 as n) select * from sample' }, { cwd }))
    .toBe('{"n":2}\n(1 rows)');
});

test('inspectUrl bundles the crawl state and scraped data of a url', async () => {
  const stamp = Date.now(); // unique per run: this suite does not zap
  await db.query('insert into crawler (name) values (?)', `inspect-${stamp}`);
  const [site] = await db.query<any[]>(
    'insert into site (name, crawler_id, currency) select ?, id, ? from crawler where name = ? returning id',
    `inspect-${stamp}`, 'AUD', `inspect-${stamp}`
  );
  const pageUrl = `https://inspect.test/${stamp}/p`;
  const [row] = await db.query<any[]>(
    'insert into url (site_id, type, url, hash, status, version, visit_time) values (?, ?, ?, ?, 2, 1, now()) returning id',
    site.id, 'product', pageUrl, sha1(pageUrl)
  );
  const [product] = await db.query<any[]>("insert into product (site_id, code, name) values (?, 'P1', 'Thing') returning id", site.id);
  const [variant] = await db.query<any[]>(
    "insert into product_variant (product_id, code, price, availability) values (?, '', 10, 'in_stock') returning id",
    product.id
  );
  await db.query('insert into product_url (product_id, url_id) values (?, ?)', product.id, row.id);
  await db.query("insert into url_fetch (url_id, fetch_time, http_status, content_type, content_length) values (?, now(), 200, 'text/html', 5)", row.id);
  await db.query("insert into variant_price (variant_id, observed_at, currency, price, availability) values (?, now(), 'AUD', 10, 'in_stock')", variant.id);
  const [queuedUrl] = await db.query<any[]>(
    "insert into url (site_id, type, url, hash, status) values (?, 'product', 'https://inspect.test/q', 'inspectq', 0) returning id",
    site.id
  );
  await db.query('insert into url_graph (src_id, dst_id) values (?, ?)', row.id, queuedUrl.id);
  const [cat] = await db.query<any[]>(
    'insert into category (site_id, url_id, name) values (?, ?, ?) returning id',
    site.id, row.id, 'Listed'
  );
  await db.query('insert into product_category (product_id, category_id) values (?, ?)', product.id, cat.id);

  const out = await inspectUrl.execute({ url: pageUrl }, { cwd });
  expect(out).toContain(`url ${pageUrl}`);
  expect(out).toContain('status=2 (done)');
  expect(out).toContain('latest fetch: HTTP 200');
  expect(out).toContain('saved snapshots: (none found)');
  expect(out).toContain('page snapshots: off (no HTML store configured)');
  expect(out).toContain('products scraped from this url: 1');
  expect(out).toContain('products listed on this page: 1');
  expect(out).toContain('urls enqueued from this page: 1');
  expect(out).toContain('- [product] https://inspect.test/q');
  expect(out).toContain('[1] P1 - Thing');
  expect(out).toMatch(/- default price=10 avail=in_stock/);
  expect(out).toMatch(/last observed: .* AUD price=10 avail=in_stock/);

  expect(await inspectUrl.execute({ url: String(row.id) }, { cwd })).toContain('[1] P1 - Thing');
  expect(await inspectUrl.execute({ url: 'https://inspect.test/nope' }, { cwd })).toBe(
    'No url row found for "https://inspect.test/nope".'
  );
});

test('scrapePreview runs a crawler on a saved page without writing', async () => {
  const out = await scrapePreviewTool.execute(
    { site: 'tool-site', type: 'product', file: 'test/fixtures/template-product.html', url: 'https://shop.test/p' },
    { cwd: process.cwd() }
  );
  const preview = JSON.parse(out);
  expect(preview.product.count).toBe(1);
  expect(preview.product.records[0]).toMatchObject({ code: 'TB-1' });
  expect(preview.product_variant.count).toBeGreaterThanOrEqual(1);
});

test.each([false, true])('HTML and preview tools decode saved responses (gzip=%s)', async (compress) => {
  const file = join(cwd, `snapshot-${compress}`);
  const now = new Date();
  await new Response({
    url: 'https://shop.test/p', requestUrl: 'https://shop.test/p', statusCode: 200,
    headers: { 'content-type': 'text/html' }, httpVersion: '1.1',
    body: readFileSync('test/fixtures/template-product.html'), fetchStart: now, fetchEnd: now,
  }).save(file, { compress });
  expect(await html.execute({ file, selector: 'h1' }, { cwd })).toContain('Template Basin');
  const preview = JSON.parse(await scrapePreviewTool.execute({
    site: 'tool-site', type: 'product', file, url: 'https://shop.test/p',
  }, { cwd: process.cwd() }));
  expect(preview.product.records[0]).toMatchObject({ code: 'TB-1' });
});

test('registration persists snapshot policy and restores gzip when the setting is removed', async () => {
  await db.buildSchema();
  const file = join(fixtureSitesDir, 'storage-policy.ts');
  try {
    for (const policy of ['off', 'raw', undefined]) {
      jest.resetModules(); // Jest maintains a module registry separate from Node's require.cache.
      writeFileSync(file, `export const site = ${JSON.stringify(policy ? { pageSnapshots: policy } : {})};`);
      const registered = await registerSite(db, config, 'storage-policy');
      expect(registered.pageSnapshots).toBe(policy ?? 'gzip');
      const [row] = await db.query<any[]>("select page_snapshots from crawler where name = 'storage-policy'");
      expect(row.page_snapshots).toBe(policy ?? 'gzip');
    }
    writeFileSync(file, `export const site = { pageSnapshots: 'typo' };`);
    jest.resetModules();
    await expect(registerSite(db, config, 'storage-policy')).rejects.toThrow(/pageSnapshots/);

    jest.resetModules();
    writeFileSync(file, `export const site = { allow: ['/shop/fruit'], disallow: ['/shop/'] };`);
    await registerSite(db, config, 'storage-policy');
    const [rules] = await db.query<any[]>("select allow, disallow from crawler where name = 'storage-policy'");
    expect(rules).toEqual({ allow: ['/shop/fruit'], disallow: ['/shop/'] });
    jest.resetModules();
    writeFileSync(file, `export const site = { disallow: ['shop/'] };`);
    await expect(registerSite(db, config, 'storage-policy')).rejects.toThrow(/starting with \//);

    jest.resetModules();
    writeFileSync(file, `export const site = { scope: ' pizzas only ' };`);
    await registerSite(db, config, 'storage-policy');
    const scoped = async () => (await db.query<any[]>("select scope from site where name = 'storage-policy'"))[0].scope;
    expect(await scoped()).toBe('pizzas only');
    jest.resetModules();
    writeFileSync(file, `export const site = {};`);
    await registerSite(db, config, 'storage-policy');
    expect(await scoped()).toBeNull();
    jest.resetModules();
    writeFileSync(file, `export const site = { scope: ' ' };`);
    await expect(registerSite(db, config, 'storage-policy')).rejects.toThrow(/scope/);

    const refresh = async () =>
      (await db.query<any[]>("select refresh_minutes from crawler where name = 'storage-policy'"))[0].refresh_minutes;
    for (const [value, minutes] of [['30m', 30], ['6h', 360], ['1d', 1440]] as const) {
      jest.resetModules();
      writeFileSync(file, `export const site = { refresh: '${value}' };`);
      await registerSite(db, config, 'storage-policy');
      expect(await refresh()).toBe(minutes);
    }
    jest.resetModules();
    writeFileSync(file, `export const site = {};`);
    await registerSite(db, config, 'storage-policy');
    expect(await refresh()).toBeNull();
    jest.resetModules();
    writeFileSync(file, `export const site = { refresh: 'daily' };`);
    await expect(registerSite(db, config, 'storage-policy')).rejects.toThrow(/refresh must be a duration/);

    jest.resetModules();
    writeFileSync(file, `export const site = { expect: { products: [40, 70], fields: ['price'] } };`);
    await registerSite(db, config, 'storage-policy');
    const [registered] = await db.query<any[]>("select expect from site where name = 'storage-policy'");
    expect(registered.expect).toEqual({ products: [40, 70], fields: ['price'] });
    jest.resetModules();
    writeFileSync(file, `export const site = { expect: { products: [70, 40] } };`);
    await expect(registerSite(db, config, 'storage-policy')).rejects.toThrow(/expect.products/);
  } finally {
    rmSync(file, { force: true });
    await db.query("delete from site where name = 'storage-policy'");
    await db.query("delete from crawler where name = 'storage-policy'");
  }
});

test('dryRun scrapes several pages and isolates a failing fixture', async () => {
  const out = await dryRunTool.execute(
    {
      site: 'tool-site',
      pages: [
        { type: 'product', file: 'test/fixtures/template-product.html', url: 'https://shop.test/p1' },
        { type: 'product', file: 'test/fixtures/does-not-exist.html', url: 'https://shop.test/p2' },
      ],
      tables: ['product'],
      limit: 2,
    },
    { cwd: process.cwd() }
  );
  const results = JSON.parse(out);
  expect(results).toHaveLength(2);
  expect(results[0]).toMatchObject({ ok: true, type: 'product', url: 'https://shop.test/p1' });
  expect(results[0].tables.product).toMatchObject({
    count: 1,
    records: [expect.objectContaining({ code: 'TB-1' })],
  });
  expect(results[1]).toMatchObject({ ok: false, url: 'https://shop.test/p2' });
  expect(results[1].error).toContain('ENOENT');
});

test('validateCrawler checks types and isolates fixture failures in its overall verdict', async () => {
  const validate = named('validateCrawler');
  const args = {
    site: 'tool-site',
    pages: [{ type: 'product', file: 'test/fixtures/template-product.html', url: 'https://shop.test/p' }],
    tables: ['product'], limit: 1,
  };
  const passed = JSON.parse(await validate.execute(args, { cwd: process.cwd() }));
  expect(passed).toMatchObject({ ok: true, typecheck: { ok: true, diagnostics: [] } });
  expect(passed.pages[0].tables.product.count).toBe(1);
  expect(passed.nextStep).toContain('jscrawl_populate');
  const failed = JSON.parse(await validate.execute({
    ...args, pages: [...args.pages, { type: 'product', file: 'missing.html', url: 'https://shop.test/missing' }],
  }, { cwd: process.cwd() }));
  expect(failed.ok).toBe(false);
  expect(failed.pages.map((page: { ok: boolean }) => page.ok)).toEqual([true, false]);
  expect(failed.pages[1].error).toContain('ENOENT');
}, 30_000);

test('html inventories inline scripts and extracts embedded JSON by id, index and path', async () => {
  const repo = process.cwd();
  writeFileSync(
    join(cwd, 'probe.html'),
    '<html><head>' +
      '<script id="state" type="application/json">{"options_with_values":[{"name":"Size","values":["S"]}]}</script>' +
      '<script>window.CONFIG = {"theme":"dark","menus":[]}</script>' +
      '<script src="/app.js"></script>' +
      '<script type="application/json">{"product":{"featured_image":"img.jpg","media":[]}}</script>' +
      '</head><body></body></html>'
  );
  const file = join(cwd, 'probe.html');
  const scripts = await html.execute({ file, output: 'scripts' }, { cwd });
  expect(scripts).toContain('3 inline scripts');
  expect(scripts).toContain('id=state');
  expect(scripts).toContain('window.CONFIG =');
  expect(scripts).toContain('keys: theme, menus');

  const blob = JSON.parse(await html.execute({ file, json: '#state' }, { cwd }));
  expect(blob).toHaveProperty('options_with_values');
  const name = await html.execute({ file, json: '#state', path: 'options_with_values.0.name' }, { cwd });
  expect(JSON.parse(name)).toBe('Size');
  const theme = await html.execute({ file, json: 'window.CONFIG =', path: 'theme' }, { cwd });
  expect(JSON.parse(theme)).toBe('dark');
  await expect(html.execute({ file, json: '#nope' }, { cwd })).rejects.toThrow(/No JSON found/);

  // Inventory indexes address the same scripts, src ones excluded: [3] is the
  // anonymous application/json blob an id or assignment marker cannot reach.
  expect(JSON.parse(await html.execute({ file, json: '[1]' }, { cwd }))).toHaveProperty('options_with_values');
  expect(JSON.parse(await html.execute({ file, json: '[2]', path: 'theme' }, { cwd }))).toBe('dark');
  expect(JSON.parse(await html.execute({ file, json: '[3]', path: 'product.featured_image' }, { cwd }))).toBe('img.jpg');
  await expect(html.execute({ file, json: '[9]' }, { cwd })).rejects.toThrow(/No JSON found/);

  const fixture = 'test/fixtures/ideal-bathroom-product.html';
  expect(await html.execute({ file: fixture, output: 'scripts' }, { cwd: repo })).toContain('application/ld+json');
});

test('webfetch summarizes JSON, retries 429s and creates saveTo directories', async () => {
  const summary = await webfetch.execute({ url: `${base}/json`, format: 'json' }, { cwd });
  expect(summary).toContain('products: array[1]');
  expect(summary).toContain('count: 1');

  const flaky = await webfetch.execute({ url: `${base}/flaky` }, { cwd });
  expect(flaky).toMatch(new RegExp(`^HTTP 200 GET ${base}/flaky`));

  await webfetch.execute({ url: base, saveTo: 'nested/dir/page.html' }, { cwd });
  expect(readFileSync(join(cwd, 'nested/dir/page.html'))).toEqual(page);
}, 30_000);

test('dbSchema lists columns and constraints, and rejects unknown tables', async () => {
  const all = await dbSchemaTool.execute({}, { cwd });
  expect(all).toContain('product:');
  const product = await dbSchemaTool.execute({ table: 'product' }, { cwd });
  expect(product).toContain('code text not null');
  expect(product).toContain('UNIQUE (site_id, code)');
  await expect(dbSchemaTool.execute({ table: 'nope' }, { cwd })).rejects.toThrow(/No table "nope"/);
});

describe('cli', () => {
  // Crawlers live in their own repository, so the CLI is pointed at a fixture
  // directory; the template's imports are rewritten for the fixture's depth.
  const sitesDir = 'test/fixtures/crawlers';
  const run = (...args: string[]) =>
    promisify(execFile)('npx', ['ts-node', 'src/cli.ts', ...args], {
      env: { ...process.env, JSCRAWL_SITES_DIR: sitesDir },
    });
  const module = `${sitesDir}/agent-test-site.ts`;

  beforeAll(() => {
    mkdirSync(sitesDir, { recursive: true });
    writeFileSync(
      module,
      readFileSync('skills/new-site/template.ts', 'utf8').replaceAll("from '../src/core/", "from '../../../src/core/")
    );
  });
  afterAll(() => rmSync(sitesDir, { recursive: true, force: true }));

  test('--scrape-file prints what the template crawler extracts from a saved page', async () => {
    // The fixture carries the markers the template's pageKind looks for: a page
    // with none of them is an unrecognised template and must throw, not vouch.
    const { stdout } = await run(
      '--scrape-file', 'agent-test-site', 'product', 'test/fixtures/template-product.html',
      '--url', 'https://shop.test/products/template-basin'
    );
    const records = JSON.parse(stdout);
    expect(records.product).toEqual([expect.objectContaining({ code: 'TB-1', name: 'Template Basin' })]);
    expect(records.product_variant).toEqual([expect.objectContaining({ product: 'TB-1', sku: 'TB-1', price: 120 })]);
    expect(records.product_image).toHaveLength(2);
    expect(records.product_attribute).toEqual([
      expect.objectContaining({ name: 'Material' }),
      expect.objectContaining({ name: 'Width' }),
    ]);
    // Only catalogue links are queued: the blog and mailto links are dropped.
    const urls = records.url.map((row: { url: string }) => row.url);
    expect(urls).toContain('https://shop.test/collections/basins');
    expect(urls).toContain('https://shop.test/products/other-basin');
    expect(urls.some((url: string) => url.includes('/blog/') || url.startsWith('mailto:'))).toBe(false);
  }, 60_000);

  test('--setup registers the site declared by its module', async () => {
    await run('--setup', 'agent-test-site');
    // the CLI uses etc/config.json (the dev database); check there
    const dev = new Database({ ...(JSON.parse(readFileSync('etc/config.json', 'utf8')).database) });
    try {
      const rows = await dev.query<any[]>(
        `select s.name, s.currency, c.wait_time, u.url, u.type from site s join crawler c on c.id = s.crawler_id
         join url u on u.site_id = s.id where s.name = 'agent-test-site'`
      );
      expect(rows).toEqual([{ name: 'agent-test-site', currency: 'AUD', wait_time: 2, url: 'https://www.example.com/', type: 'seed' }]);
      await dev.query("delete from url where site_id in (select id from site where name = 'agent-test-site')");
      await dev.query("delete from site where name = 'agent-test-site'");
      await dev.query("delete from crawler where name = 'agent-test-site'");
    } finally {
      await dev.end();
    }
  }, 60_000);

  test('--populate registers every module in the sites directory', async () => {
    const { stdout } = await run('--populate');
    expect(stdout).toContain('Populated 1 site(s)');
    const dev = new Database({ ...(JSON.parse(readFileSync('etc/config.json', 'utf8')).database) });
    try {
      const rows = await dev.query<any[]>(
        `select s.name, u.url, u.type from site s join url u on u.site_id = s.id where s.name = 'agent-test-site'`
      );
      expect(rows).toEqual([{ name: 'agent-test-site', url: 'https://www.example.com/', type: 'seed' }]);
      await dev.query("delete from url where site_id in (select id from site where name = 'agent-test-site')");
      await dev.query("delete from site where name = 'agent-test-site'");
      await dev.query("delete from crawler where name = 'agent-test-site'");
    } finally {
      await dev.end();
    }
  }, 60_000);
});
