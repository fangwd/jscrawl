import { createServer, Server } from 'http';
import { AddressInfo } from 'net';
import { Database } from 'sqlex';
import { probePage } from '../src/core/pageprobe';
import { domainTools } from '../src/mcp/tools';

const PAGE = `<!doctype html><html><head>
<link rel="stylesheet" href="/wp-content/themes/x/style.css">
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"Probe Widget"}</script>
<script>window.__STATE__ = {"ok":true,"items":[1,2,3]}</script>
</head><body><div id="app">shell</div><div id="menu"></div>
<script>
fetch('/api/items').then(function (r) { return r.json(); }).then(function (j) {
  document.getElementById('app').textContent = 'got ' + j.n;
});
fetch('/api/menu', { method: 'POST', body: '{"shop":7}' }).then(function (r) { return r.json(); }).then(function (j) {
  document.getElementById('menu').innerText = j.menu.items.map(function (i) { return i.name; }).join('\\n');
});
</script>
</body></html>`;

// a theme that renders one combination and loads another's buying options as markup when a size is picked
const PICKER = `<!doctype html><html><body><h1>Cuddler</h1><div id="buy"><p>Medium $115.95</p></div>
<select name="size"><option value="m" selected>Medium</option><option value="l">Large</option></select>
<script>
document.querySelector('select').addEventListener('change', function (e) {
  fetch('/ajax/options?size=' + e.target.value, { headers: { 'x-requested-with': 'XMLHttpRequest' } })
    .then(function (r) { return r.text(); }).then(function (t) { document.getElementById('buy').innerHTML = t; });
});
</script></body></html>`;

let server: Server;
let base: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === '/streaming') {
      res.writeHead(200, { 'content-type': 'text/html' }).end("<html><body>live<script>fetch('/api/stream')</script></body></html>");
    } else if (req.url === '/api/stream') {
      // a long poll: the body starts and never ends
      res.writeHead(200, { 'content-type': 'application/json' }).write('{"events":[');
    } else if (req.url === '/picker') {
      res.writeHead(200, { 'content-type': 'text/html' }).end(PICKER);
    } else if (req.url?.startsWith('/ajax/options')) {
      res.writeHead(200, { 'content-type': 'text/plain' }).end('<p>Large $135.95</p><p>Cuddler</p>');
    } else if (req.url === '/api/items') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ n: 42, items: [{ id: 1, price: 9.99 }] }));
    } else if (req.url === '/api/menu' && req.method === 'POST') {
      // slow, like a real catalogue feed, so it is still in flight when networkidle2 fires
      const menu = JSON.stringify({ menu: { items: [{ name: 'Garlic Bread' }, { name: 'Margherita Pizza' }] } });
      setTimeout(() => res.writeHead(200, { 'content-type': 'application/json' }).end(menu), 1500);
    } else {
      res.writeHead(200, { 'content-type': 'text/html' }).end(PAGE);
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  server.closeAllConnections();
  server.close();
});

test('pageProbe reports network JSON, embedded state, framework hints and JSON-LD', async () => {
  const report = await probePage(`${base}/page`);
  expect(report.document).toMatchObject({ status: 200 });
  expect(report.document.renderedBytes).toBeGreaterThan(0);
  expect(report.framework).toContain('wordpress');
  expect(report.jsonLdTypes).toContain('Product');

  const state = report.embeddedScripts.find((s) => s.marker.includes('__STATE__'));
  expect(state).toMatchObject({ parses: true });
  expect(state!.preview).toContain('"ok":true');

  const api = report.network.find((n) => n.url.endsWith('/api/items'));
  expect(api).toBeDefined();
  expect(api!.status).toBe(200);
  expect(api!.bytes).toBeGreaterThan(0);
  expect(api!.body).toContain('42');

  expect(report.network[0]).toMatchObject({
    method: 'POST',
    requestBody: '{"shop":7}',
    pageTextHits: 2,
    pageTextPaths: ['menu.items.*.name (2)'],
  });
  expect(report.network[0].url).toMatch(/\/api\/menu$/);
}, 60_000);

test('interact picks another option and lists the markup the page fetched for it, with its headers', async () => {
  const report = await probePage(`${base}/picker`, { interact: true });
  expect(report.network).toEqual([]);
  expect(report.interactions!.pickers).toEqual(['size = Large']);
  expect(report.interactions!.network).toEqual([
    expect.objectContaining({
      method: 'GET',
      url: `${base}/ajax/options?size=l`,
      contentType: 'text/plain',
      requestHeaders: { accept: '*/*', 'x-requested-with': 'XMLHttpRequest' },
      body: '<p>Large $135.95</p><p>Cuddler</p>',
    }),
  ]);
  // the page as rendered before the pick: a fixture for a browser-only site
  expect(report.rendered).toContain('Medium $115.95');
}, 60_000);

test('a response that never finishes does not hold the probe past its timeout', async () => {
  const report = await probePage(`${base}/streaming`, { timeoutMs: 2000 });
  expect(report.document).toMatchObject({ status: 200 });
}, 20_000);

test('the pageProbe tool renders the report as text', async () => {
  const connection = { host: '127.0.0.1', port: 5434, user: 'admin', password: 'secret', database: 'jscrawl_test' };
  const db = new Database({ dialect: 'postgres', connection });
  const config = { database: { dialect: 'postgres', connection }, store: {} } as any;
  try {
    const tools = domainTools({ db, config, cwd: process.cwd(), jscrawlUrl: 'http://127.0.0.1:3120', imagedUrl: 'http://127.0.0.1:1' });
    const tool = tools.find((t) => t.name === 'pageProbe')!;
    const out = await tool.execute({ url: `${base}/page` }, { cwd: process.cwd() });
    expect(out).toContain('/api/items');
    expect(out).toContain('POST');
    expect(out).toContain('page texts at: menu.items.*.name (2)');
    expect(out).toContain('window.__STATE__ =');
    expect(out).toContain('wordpress');
    expect(out).toContain('Prefer the cheapest source');
  } finally {
    await db.end();
  }
}, 60_000);
