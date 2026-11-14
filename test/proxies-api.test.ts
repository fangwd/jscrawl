import { createServer, Server } from 'http';
import { AddressInfo } from 'net';

import { ProxyProvider } from '../src/core/proxy';
import { webHandler, WebDeps } from '../src/web/routes';
import { startProvider } from './support/proxyProvider';

const API_TOKEN = 'test-api-token-0123456789';
const env = { ...process.env };
let provider: Awaited<ReturnType<typeof startProvider>>;
let server: Server;
let checker: Server;
let base: string;

/** The runs and sites the overview looks up, by the SQL it sends. */
const db = {
  async query(sql: string, ...args: unknown[]) {
    if (sql.includes('from crawler_run')) {
      return [
        { id: 42, status: 'running', site_id: 12, site_name: 'national-tiles' },
        { id: 7, status: 'stopped', site_id: 3, site_name: 'amber-tiles' },
      ].filter((run) => args.includes(run.id));
    }
    return [{ id: 12, name: 'national-tiles', type: 'tor', country: 'AU' }];
  },
};

const call = async (method: string, path: string) => {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${API_TOKEN}` },
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : undefined };
};

beforeAll(async () => {
  server = createServer(webHandler({ apiToken: API_TOKEN, db } as unknown as WebDeps));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  // an IP echo only the proxy can reach: its host name resolves at the exit
  checker = createServer((_req, res) =>
    res
      .writeHead(200, { 'content-type': 'application/json' })
      .end('{"ip":"203.0.113.7","country":"au"}'),
  );
  await new Promise<void>((resolve) => checker.listen(0, '127.0.0.1', resolve));
});

afterAll(async () => {
  server.close();
  checker.close();
});

beforeEach(async () => {
  provider = await startProvider();
  process.env.PROXY_PROVIDER_URL = provider.url;
  process.env.PROXY_PROVIDER_TOKEN = provider.token;
  process.env.PROXY_CHECK_URL = `http://exit-check.test:${(checker.address() as AddressInfo).port}/json`;
});

afterEach(async () => {
  await provider.close();
  process.env = { ...env };
});

test('without a provider the overview says so, and the actions answer 404', async () => {
  delete process.env.PROXY_PROVIDER_URL;
  expect((await call('GET', '/api/proxies')).body).toEqual({
    configured: false,
    proxies: [],
    sites: [{ id: 12, name: 'national-tiles', type: 'tor', country: 'AU' }],
  });
  expect(await call('POST', '/api/proxies/0/renew')).toEqual({
    status: 404,
    body: { error: 'No proxy provider is configured' },
  });
});

test('the overview names who holds each proxy and flags what is left over', async () => {
  const gone = 2 ** 22 + 12345;
  const proxy = (id: number, owner?: string) => ({
    id,
    url: 'socks5h://127.0.0.1:1',
    type: 'tor',
    country: 'AU',
    owner,
  });
  provider.adopt(proxy(0, 'jscrawl:run:42'));
  provider.adopt(proxy(1, 'jscrawl:run:7'));
  provider.adopt(proxy(2, 'jscrawl:tools'));
  provider.adopt(proxy(3, `jscrawl:pid:${gone}`));
  provider.adopt(proxy(4, 'someone-else'));
  provider.adopt({
    id: 5,
    url: 'http://torm:s3cret@127.0.0.1:2/',
    type: 'vpngate',
    country: 'JP',
    owner: 'jscrawl:tools',
    status: 'missing',
  });

  const { status, body } = await call('GET', '/api/proxies');
  expect(status).toBe(200);
  expect(body.configured).toBe(true);
  expect(body.proxies).toEqual([
    {
      id: 0,
      type: 'tor',
      country: 'AU',
      status: null,
      holder: {
        kind: 'run',
        runId: 42,
        siteId: 12,
        siteName: 'national-tiles',
        status: 'running',
      },
      leftover: false,
    },
    {
      id: 1,
      type: 'tor',
      country: 'AU',
      status: null,
      holder: {
        kind: 'run',
        runId: 7,
        siteId: 3,
        siteName: 'amber-tiles',
        status: 'stopped',
      },
      leftover: true,
    },
    {
      id: 2,
      type: 'tor',
      country: 'AU',
      status: null,
      holder: { kind: 'tools' },
      leftover: false,
    },
    {
      id: 3,
      type: 'tor',
      country: 'AU',
      status: null,
      holder: { kind: 'process', pid: gone },
      leftover: true,
    },
    {
      id: 4,
      type: 'tor',
      country: 'AU',
      status: null,
      holder: { kind: 'other', owner: 'someone-else' },
      leftover: false,
    },
    {
      id: 5,
      type: 'vpngate',
      country: 'JP',
      status: 'missing',
      holder: { kind: 'tools' },
      leftover: false,
    },
  ]);
  expect(JSON.stringify(body)).not.toContain('socks5h://');
  expect(JSON.stringify(body)).not.toContain('s3cret');
});

test('a provider that cannot be listed is reported, not thrown', async () => {
  process.env.PROXY_PROVIDER_URL = 'http://127.0.0.1:1';
  const { status, body } = await call('GET', '/api/proxies');
  expect(status).toBe(200);
  expect(body.configured).toBe(true);
  expect(body.error).toMatch(/proxy provider GET \/proxies/);
});

test('a proxy is renewed, checked through itself and removed', async () => {
  await ProxyProvider.fromEnv()!.create({ type: 'tor', country: 'AU' }, 'jscrawl:tools');

  expect(await call('POST', '/api/proxies/0/renew')).toEqual({
    status: 200,
    body: { id: 0, type: 'tor', country: 'AU', owner: 'jscrawl:tools' },
  });
  expect(provider.calls).toContain('POST /proxies/0/renew');

  const checked = await call('POST', '/api/proxies/0/check');
  expect(checked.status).toBe(200);
  expect(checked.body).toMatchObject({
    ip: '203.0.113.7',
    country: 'AU',
    expected: 'AU',
    checkUrl: process.env.PROXY_CHECK_URL,
  });
  expect(provider.proxies.get(0)!.socks.connects).toEqual([
    `exit-check.test:${(checker.address() as AddressInfo).port}`,
  ]);

  expect((await call('DELETE', '/api/proxies/0')).status).toBe(204);
  expect(provider.proxies.size).toBe(0);
  expect((await call('DELETE', '/api/proxies/0')).status).toBe(404);
  expect((await call('POST', '/api/proxies/0/check')).status).toBe(404);
  expect((await call('PUT', '/api/proxies/0')).status).toBe(405);
});
