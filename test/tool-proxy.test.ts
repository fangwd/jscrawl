import { Database } from 'sqlex';

import { Config } from '../src/core/models';
import { LeasedProxies, processOwner, ProxyPool, useProxies } from '../src/core/proxy';
import { domainTools } from '../src/mcp/tools';
import { startProvider, startSite } from './support/proxyProvider';

let provider: Awaited<ReturnType<typeof startProvider>>;
let site: Awaited<ReturnType<typeof startSite>>;
let pool: ProxyPool;
let rows: {
  id: number;
  name: string;
  seed: string;
  proxy_type: string | null;
  proxy_country: string | null;
}[];
const env = { ...process.env };
const db = { query: async () => rows } as unknown as Database;
const config = {} as Config;

beforeAll(async () => {
  site = await startSite([200]);
});
afterAll(async () => {
  await site.close();
});

beforeEach(async () => {
  provider = await startProvider();
  process.env.PROXY_PROVIDER_URL = provider.url;
  process.env.PROXY_PROVIDER_TOKEN = provider.token;
  pool = new ProxyPool();
  useProxies(pool);
  rows = [
    {
      id: 1,
      name: 'shop-au',
      seed: `${site.url}/au/`,
      proxy_type: 'residential',
      proxy_country: 'AU',
    },
    {
      id: 2,
      name: 'shop-nz',
      seed: `${site.url}/nz/`,
      proxy_type: 'residential',
      proxy_country: 'NZ',
    },
  ];
});

afterEach(async () => {
  await pool.close();
  await provider.close();
  useProxies(new LeasedProxies(processOwner()));
  process.env = { ...env };
});

async function webfetch(path: string, explicitSite?: string) {
  const tool = domainTools({
    db,
    config,
    cwd: process.cwd(),
    jscrawlUrl: 'http://127.0.0.1',
  }).find((tool) => tool.name === 'webfetch')!;
  const result = await tool.execute(
    { url: `${site.url}${path}`, site: explicitSite },
    { cwd: process.cwd() },
  );
  expect(result).toContain('HTTP 200');
}

test.each([
  ['/nz/page', 'NZ'],
  ['/au/page', 'AU'],
])('webfetch uses the country of the regional seed containing %s', async (path, country) => {
  await webfetch(path);
  expect(provider.created).toEqual([{ type: 'residential', country, owner: 'jscrawl:tools' }]);
});

test('webfetch prefers a regional proxy over an earlier root seed', async () => {
  rows.unshift({
    id: 3,
    name: 'shop',
    seed: `${site.url}/`,
    proxy_type: 'residential',
    proxy_country: 'US',
  });
  await webfetch('/nz/page');
  expect(provider.created).toEqual([
    { type: 'residential', country: 'NZ', owner: 'jscrawl:tools' },
  ]);
});

test.each([
  ['shop-au', 'AU'],
  ['2', 'NZ'],
])('webfetch honours an explicit site: %s', async (name, country) => {
  await webfetch('/other/page', name);
  expect(provider.created).toEqual([{ type: 'residential', country, owner: 'jscrawl:tools' }]);
});

test("webfetch does not use another region's proxy for an unmatched path", async () => {
  await webfetch('/austria/page');
  expect(provider.created).toEqual([]);
});

test("a direct regional site does not inherit the root site's proxy", async () => {
  rows.unshift({
    id: 3,
    name: 'shop',
    seed: `${site.url}/`,
    proxy_type: 'residential',
    proxy_country: 'US',
  });
  rows[2].proxy_type = null;
  rows[2].proxy_country = null;
  await webfetch('/nz/page');
  expect(provider.created).toEqual([]);
});
