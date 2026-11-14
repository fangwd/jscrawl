import { createServer, Server } from 'http';
import { AddressInfo } from 'net';

import { LeasedProxies, processOwner, ProxyPool, useProxies } from '../src/core/proxy';
import { sha1 } from '../src/core/utils';
import { webHandler, WebDeps } from '../src/web/routes';
import { startProvider } from './support/proxyProvider';

const API_TOKEN = 'test-api-token-0123456789';
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
let provider: Awaited<ReturnType<typeof startProvider>>;
let server: Server;
let site: Server;
let base: string;
let images: string;
const env = { ...process.env };

/** The image url rows the route looks up, by site and hash: a proxied site's, a direct site's. */
const rows: {
  site: string;
  id: string;
  url: string;
  proxy_type: string | null;
  proxy_country: string | null;
}[] = [];
const db = {
  async query(sql: string, hashes: string[], name: string, id: string) {
    if (!sql.includes("u.type = 'image'")) throw new Error(`unexpected query: ${sql}`);
    return rows.filter((r) => hashes.includes(sha1(r.url)) && (r.site === name || r.id === id));
  },
};

const get = (path: string) =>
  fetch(`${base}${path}`, {
    headers: { authorization: `Bearer ${API_TOKEN}` },
  });
const image = (site: string, url: string) =>
  get(`/api/sites/${site}/image?url=${encodeURIComponent(url)}`);

beforeAll(async () => {
  // the site's image host; the test proxies resolve every host name to this machine
  site = createServer((req, res) => {
    if (req.url === '/a.png' || req.url === '/a.png?w=1,h=1')
      res.writeHead(200, { 'content-type': 'image/png' }).end(PNG);
    else if (req.url === '/page')
      res.writeHead(200, { 'content-type': 'text/html' }).end('<html></html>');
    else res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => site.listen(0, '127.0.0.1', resolve));
  const port = (site.address() as AddressInfo).port;
  images = `images.shop.test:${port}`;
  const proxied = {
    site: 'tiles',
    id: '7',
    proxy_type: 'tor',
    proxy_country: 'AU',
  };
  const direct = {
    site: 'paints',
    id: '8',
    proxy_type: null,
    proxy_country: null,
  };
  rows.push(
    { ...proxied, url: `http://${images}/a.png` },
    { ...proxied, url: `http://${images}/gone.png` },
  );
  rows.push(
    { ...direct, url: `http://127.0.0.1:${port}/a.png?w=1,h=1` },
    { ...direct, url: `http://127.0.0.1:${port}/page` },
  );
  server = createServer(webHandler({ apiToken: API_TOKEN, db } as unknown as WebDeps));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.close();
  site.close();
  useProxies(new LeasedProxies(processOwner()));
});

beforeEach(async () => {
  provider = await startProvider();
  process.env.PROXY_PROVIDER_URL = provider.url;
  process.env.PROXY_PROVIDER_TOKEN = provider.token;
  useProxies(new ProxyPool(60_000, 'jscrawl:pid:4242'));
});

afterEach(async () => {
  await provider.close();
  process.env = { ...env };
});

test("a site's image is fetched through the proxy its crawler names, one proxy for all its images", async () => {
  for (const site of ['tiles', '7']) {
    const response = await image(site, `http://${images}/a.png`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(Buffer.from(await response.arrayBuffer())).toEqual(PNG);
  }
  expect(provider.created).toEqual([{ type: 'tor', country: 'AU', owner: 'jscrawl:pid:4242' }]);
  expect(provider.proxies.get(0)!.socks.connects).toEqual([images, images]);
});

test('a site without a proxy is fetched directly, a url as its feed writes it; what is not its image is refused', async () => {
  const port = (site.address() as AddressInfo).port;
  // the feed writes a comma in a url as %2C
  expect(
    Buffer.from(
      await (await image('paints', `http://127.0.0.1:${port}/a.png?w=1%2Ch=1`)).arrayBuffer(),
    ),
  ).toEqual(PNG);
  expect(provider.created).toEqual([]);
  // another site's image, and none at all
  expect((await image('paints', `http://${images}/a.png`)).status).toBe(404);
  expect((await get('/api/sites/tiles/image')).status).toBe(400);
  const gone = await image('tiles', `http://${images}/gone.png`);
  expect([gone.status, await gone.json()]).toEqual([502, { error: 'The site answered HTTP 404' }]);
  const page = await image('paints', `http://127.0.0.1:${port}/page`);
  expect([page.status, await page.json()]).toEqual([
    502,
    { error: 'The site answered text/html, not an image' },
  ]);
  expect((await fetch(`${base}/api/sites/tiles/image?url=x`)).status).toBe(401);
});
