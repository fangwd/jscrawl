import { Crawler } from '../src/core/base-crawler';
import { CrawlerOptions } from '../src/core/models';
import {
  LeasedProxies,
  parseProxy,
  Proxy,
  ProxyError,
  ProxyPool,
  ProxyProvider,
  ProviderProxy,
  reapProxies,
  useProxies,
  viaProxy,
} from '../src/core/proxy';
import { startProvider, startSite } from './support/proxyProvider';

let provider: Awaited<ReturnType<typeof startProvider>>;
const env = { ...process.env };
const AU = { type: 'residential', country: 'AU' };

beforeEach(async () => {
  provider = await startProvider();
  process.env.PROXY_PROVIDER_URL = provider.url;
  process.env.PROXY_PROVIDER_TOKEN = provider.token;
  useProxies(new LeasedProxies('jscrawl:test'));
});

afterEach(async () => {
  await provider.close();
  process.env = { ...env };
});

test('a crawler module declares a proxy type and an optional country', () => {
  expect(parseProxy('crawlers/x.ts', undefined)).toBeNull();
  expect(parseProxy('crawlers/x.ts', { type: 'residential', country: 'au' })).toEqual(AU);
  expect(parseProxy('crawlers/x.ts', { type: 'datacenter-2' })).toEqual({ type: 'datacenter-2', country: null });
  expect(() => parseProxy('crawlers/x.ts', 'residential')).toThrow(/crawlers\/x.ts: proxy must be an object/);
  expect(() => parseProxy('crawlers/x.ts', { type: 'Residential' })).toThrow(/proxy.type must name a type the proxy provider offers/);
  expect(() => parseProxy('crawlers/x.ts', { country: 'AU' })).toThrow(/proxy.type/);
  expect(() => parseProxy('crawlers/x.ts', { type: 'residential', country: 'AUS' })).toThrow(/two-letter country code/);
  expect(() => parseProxy('crawlers/x.ts', { type: 'residential', exit: 'AU' })).toThrow(/type and country only/);
});

test('a proxy is created for its type and country, and renewals arriving together share one', async () => {
  const proxy = await ProviderProxy.create(ProxyProvider.fromEnv()!, AU, 'jscrawl:run:7');
  expect(provider.created).toEqual([{ ...AU, owner: 'jscrawl:run:7' }]);
  expect(proxy.url).toBe(provider.proxies.get(0)!.url);
  expect(proxy.label).toBe('residential AU #0');

  await Promise.all([proxy.renew(), proxy.renew(), proxy.renew()]);
  expect(provider.calls.filter((call) => call === 'POST /proxies/0/renew')).toHaveLength(1);
  expect(proxy.generation).toBe(1);
});

test('replacing a proxy removes it and creates another of the same type and country', async () => {
  const proxy = await ProviderProxy.create(ProxyProvider.fromEnv()!, AU, 'jscrawl:run:7');
  const before = proxy.url;
  await proxy.replace();
  expect(provider.calls).toContain('DELETE /proxies/0');
  expect(provider.created).toEqual([
    { ...AU, owner: 'jscrawl:run:7' },
    { ...AU, owner: 'jscrawl:run:7' },
  ]);
  expect(proxy.url).not.toBe(before);
  expect(proxy.label).toBe('residential AU #1');
  expect(proxy.generation).toBe(1);
});

/** A proxy that records what viaProxy asked of it. */
function recorder(): Proxy & { asked: string[] } {
  const asked: string[] = [];
  return {
    url: 'socks5h://127.0.0.1:1',
    label: 'fake',
    generation: 0,
    asked,
    renew: async () => void asked.push('renew'),
    replace: async () => void asked.push('replace'),
    isDown: (error: any) => error?.code === 'ECONNREFUSED',
  };
}

test('viaProxy renews after a refusal or an error, replaces a proxy that is down, and stops at the retries', async () => {
  const proxy = recorder();
  const results = [{ statusCode: 403 }, { statusCode: 200 }];
  const statusOf = (r: { statusCode: number }) => (r.statusCode === 403 ? 'HTTP 403' : null);
  expect(await viaProxy(proxy, 3, async () => results.shift()!, statusOf)).toEqual({ statusCode: 200 });
  expect(proxy.asked).toEqual(['renew']);

  const failures: unknown[] = [Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }), new Error('Socks5 proxy rejected connection')];
  const retries: string[] = [];
  const outcome = await viaProxy(
    proxy,
    3,
    async () => {
      const failure = failures.shift();
      if (failure) throw failure;
      return 'ok';
    },
    () => null,
    (retry, failure, down) => retries.push(`${retry} ${failure} ${down}`)
  );
  expect(outcome).toBe('ok');
  expect(proxy.asked).toEqual(['renew', 'replace', 'renew']);
  expect(retries).toEqual(['1 ECONNREFUSED true', '2 Socks5 proxy rejected connection false']);

  // with the retries spent, the last answer is the caller's
  expect(await viaProxy(recorder(), 2, async () => ({ statusCode: 403 }), statusOf)).toEqual({ statusCode: 403 });
  await expect(viaProxy(recorder(), 1, () => Promise.reject(new Error('timeout')))).rejects.toThrow('timeout');
});

test('without a provider configured a site that asks for a proxy fails rather than fetching directly', async () => {
  delete process.env.PROXY_PROVIDER_URL;
  await expect(new LeasedProxies('x').get(AU)).rejects.toThrow(ProxyError);
  expect(await reapProxies({ runs: new Set(), tools: true })).toBe(0);
});

test("the provider's errors name the call and its message", async () => {
  await expect(new ProxyProvider(provider.url, 'wrong').create(AU, 'x')).rejects.toThrow(
    'proxy provider POST /proxies: HTTP 401 unauthorized'
  );
});

test('the pool shares one proxy per type and country and removes the idle ones', async () => {
  const pool = new ProxyPool(60_000);
  try {
    const [a, b] = await Promise.all([pool.get(AU), pool.get(AU)]);
    const nz = await pool.get({ type: 'residential', country: 'NZ' });
    expect(a).toBe(b);
    expect(nz).not.toBe(a);
    expect(provider.created).toEqual([
      { ...AU, owner: 'jscrawl:tools' },
      { type: 'residential', country: 'NZ', owner: 'jscrawl:tools' },
    ]);
    await pool.sweep(Date.now() + 60_001);
    expect(provider.proxies.size).toBe(0);
  } finally {
    await pool.close();
  }
});

test('reaping removes what finished runs, gone processes and old tool servers left, and nothing else', async () => {
  const gone = 2 ** 22 + 12345; // above any pid this machine hands out
  const proxy = (id: number, owner?: string) => ({ id, url: 'socks5h://127.0.0.1:1', owner });
  provider.adopt(proxy(0, 'jscrawl:run:1'));
  provider.adopt(proxy(1, 'jscrawl:run:2'));
  provider.adopt(proxy(2, `jscrawl:pid:${gone}`));
  provider.adopt(proxy(3, `jscrawl:pid:${process.pid}`));
  provider.adopt(proxy(4, 'jscrawl:tools'));
  provider.adopt(proxy(5, 'someone-else'));
  provider.adopt(proxy(6));

  expect(await reapProxies({ runs: new Set([2]) })).toBe(2);
  expect([...provider.proxies.keys()]).toEqual([1, 3, 4, 5, 6]);
  expect(await reapProxies({ tools: true })).toBe(1);
  expect([...provider.proxies.keys()]).toEqual([1, 3, 5, 6]);
});

function crawler(options: Partial<CrawlerOptions>): Crawler {
  const crawler = new Crawler(
    {
      site: {
        id: 1,
        name: 'test',
        crawler: { waitTime: 0, randomWait: 0, threadCount: 1, maxRetryCount: 3, usePuppeteer: false, pageSnapshots: 'off', ...options },
      },
    } as any,
    {} as any
  );
  crawler.logger = { info: () => undefined, warn: () => undefined, error: () => undefined } as any;
  return crawler;
}

test('a proxied site is fetched through its own proxy, which a refusal renews and closing removes', async () => {
  const site = await startSite([403, 200]);
  try {
    const proxied = crawler({ proxyType: 'residential', proxyCountry: 'AU' });
    const response = await proxied.fetchPage(`${site.url}/page`);
    expect(response.statusCode).toBe(200);
    expect(provider.created).toEqual([{ ...AU, owner: 'jscrawl:test' }]);
    expect(provider.calls.filter((call) => call === 'POST /proxies/0/renew')).toHaveLength(1);
    // robots.txt and both page attempts went through the proxy
    expect(provider.proxies.get(0)!.socks.connects).toHaveLength(3);
    await proxied.close();
    expect(provider.calls).toContain('DELETE /proxies/0');
    expect(provider.proxies.size).toBe(0);
  } finally {
    await site.close();
  }
});

test('a proxy that stopped answering is replaced and the page fetched through the new one', async () => {
  const site = await startSite([200]);
  try {
    const proxied = crawler({ proxyType: 'residential', proxyCountry: 'AU' });
    await proxied.fetchPage(`${site.url}/page`);
    await provider.crash(0);
    const response = await proxied.fetchPage(`${site.url}/page`);
    expect(response.statusCode).toBe(200);
    expect(provider.created).toHaveLength(2);
    expect(provider.proxies.get(1)!.socks.connects).toHaveLength(1);
    await proxied.close();
  } finally {
    await site.close();
  }
});

test('a site without a proxy is fetched directly, and one whose proxy cannot be created fails the fetch', async () => {
  const site = await startSite([200]);
  try {
    const direct = crawler({ proxyType: null, proxyCountry: null });
    expect((await direct.fetchPage(`${site.url}/page`)).statusCode).toBe(200);
    expect(provider.calls).toEqual([]);

    delete process.env.PROXY_PROVIDER_URL;
    const proxied = crawler({ proxyType: 'residential', proxyCountry: 'AU' });
    await expect(proxied.fetchPage(`${site.url}/page`)).rejects.toThrow(ProxyError);
    expect(site.hits).toEqual(['/robots.txt', '/page']);
  } finally {
    await site.close();
  }
});
