import { Crawler } from '../src/core/base-crawler';
import { CrawlerOptions } from '../src/core/models';
import {
  LeasedProxies,
  parseProxy,
  Proxy,
  ProxyError,
  ProxyPool,
  reapProxies,
  Torm,
  TorProxy,
  useProxies,
  viaProxy,
} from '../src/core/proxy';
import { startSite, startTorm } from './support/torm';

type FakeTorm = Awaited<ReturnType<typeof startTorm>>;
let torm: FakeTorm;
const env = { ...process.env };

beforeEach(async () => {
  torm = await startTorm();
  process.env.TORM_URL = torm.url;
  process.env.TORM_TOKEN = torm.token;
  useProxies(new LeasedProxies('jscrawl:test'));
});

afterEach(async () => {
  await torm.close();
  process.env = { ...env };
});

test('a crawler module declares a proxy type and an optional country', () => {
  expect(parseProxy('crawlers/x.ts', undefined)).toBeNull();
  expect(parseProxy('crawlers/x.ts', { type: 'tor', country: 'au' })).toEqual({ type: 'tor', country: 'AU' });
  expect(parseProxy('crawlers/x.ts', { type: 'tor' })).toEqual({ type: 'tor', country: null });
  expect(() => parseProxy('crawlers/x.ts', 'tor')).toThrow(/crawlers\/x.ts: proxy must be an object/);
  expect(() => parseProxy('crawlers/x.ts', { type: 'socks' })).toThrow(/proxy.type must be one of tor/);
  expect(() => parseProxy('crawlers/x.ts', { type: 'tor', country: 'AUS' })).toThrow(/two-letter country code/);
  expect(() => parseProxy('crawlers/x.ts', { type: 'tor', exit: 'AU' })).toThrow(/type and country only/);
});

test('a Tor proxy is started pinned to its country, and renewals arriving together share one', async () => {
  const proxy = await TorProxy.start(Torm.fromEnv()!, 'AU', 'jscrawl:run:7');
  expect(torm.starts).toEqual([{ country: 'AU', owner: 'jscrawl:run:7' }]);
  expect(proxy.url).toBe(`socks5h://127.0.0.1:${torm.instances.get(0)!.socksPort}`);
  expect(proxy.label).toBe('tor AU #0');

  await Promise.all([proxy.renew(), proxy.renew(), proxy.renew()]);
  expect(torm.calls.filter((call) => call === 'POST /instances/0/reload')).toHaveLength(1);
  expect(proxy.generation).toBe(1);
});

test('replacing a proxy stops its instance and starts another for the same country', async () => {
  const proxy = await TorProxy.start(Torm.fromEnv()!, 'AU', 'jscrawl:run:7');
  const before = proxy.url;
  await proxy.replace();
  expect(torm.calls).toContain('DELETE /instances/0');
  expect(torm.starts).toEqual([
    { country: 'AU', owner: 'jscrawl:run:7' },
    { country: 'AU', owner: 'jscrawl:run:7' },
  ]);
  expect(proxy.url).not.toBe(before);
  expect(proxy.label).toBe('tor AU #1');
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

test('without torm configured a site that asks for Tor fails rather than fetching directly', async () => {
  delete process.env.TORM_URL;
  await expect(new LeasedProxies('x').get({ type: 'tor', country: 'AU' })).rejects.toThrow(ProxyError);
  expect(await reapProxies({ runs: new Set(), tools: true })).toBe(0);
});

test('the pool shares one instance per country and stops the idle ones', async () => {
  const pool = new ProxyPool(60_000);
  try {
    const [a, b] = await Promise.all([pool.get({ type: 'tor', country: 'AU' }), pool.get({ type: 'tor', country: 'AU' })]);
    const nz = await pool.get({ type: 'tor', country: 'NZ' });
    expect(a).toBe(b);
    expect(nz).not.toBe(a);
    expect(torm.starts).toEqual([
      { country: 'AU', owner: 'jscrawl:tools' },
      { country: 'NZ', owner: 'jscrawl:tools' },
    ]);
    await pool.sweep(Date.now() + 60_001);
    expect(torm.instances.size).toBe(0);
  } finally {
    await pool.close();
  }
});

test("reaping stops what finished runs, gone processes and old tool servers left, and nothing else", async () => {
  const gone = 2 ** 22 + 12345; // above any pid this machine hands out
  const instance = (slot: number, owner?: string) => ({ slot, pid: 5000 + slot, socksAddr: '127.0.0.1', socksPort: 1, owner });
  torm.adopt(instance(0, 'jscrawl:run:1'));
  torm.adopt(instance(1, 'jscrawl:run:2'));
  torm.adopt(instance(2, `jscrawl:pid:${gone}`));
  torm.adopt(instance(3, `jscrawl:pid:${process.pid}`));
  torm.adopt(instance(4, 'jscrawl:tools'));
  torm.adopt(instance(5, 'someone-else'));
  torm.adopt(instance(6));

  expect(await reapProxies({ runs: new Set([2]) })).toBe(2);
  expect([...torm.instances.keys()]).toEqual([1, 3, 4, 5, 6]);
  expect(await reapProxies({ tools: true })).toBe(1);
  expect([...torm.instances.keys()]).toEqual([1, 3, 5, 6]);
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

test('a Tor site is fetched through its own instance, which a refusal renews and closing stops', async () => {
  const site = await startSite([403, 200]);
  try {
    const tor = crawler({ proxyType: 'tor', proxyCountry: 'AU' });
    const response = await tor.fetchPage(`${site.url}/page`);
    expect(response.statusCode).toBe(200);
    expect(torm.starts).toEqual([{ country: 'AU', owner: 'jscrawl:test' }]);
    expect(torm.calls.filter((call) => call === 'POST /instances/0/reload')).toHaveLength(1);
    // robots.txt and both page attempts went through the proxy
    expect(torm.instances.get(0)!.socks.connects).toHaveLength(3);
    await tor.close();
    expect(torm.calls).toContain('DELETE /instances/0');
    expect(torm.instances.size).toBe(0);
  } finally {
    await site.close();
  }
});

test('a Tor instance that stopped answering is replaced and the page fetched through the new one', async () => {
  const site = await startSite([200]);
  try {
    const tor = crawler({ proxyType: 'tor', proxyCountry: 'AU' });
    await tor.fetchPage(`${site.url}/page`);
    await torm.crash(0);
    const response = await tor.fetchPage(`${site.url}/page`);
    expect(response.statusCode).toBe(200);
    expect(torm.starts).toHaveLength(2);
    expect(torm.instances.get(1)!.socks.connects).toHaveLength(1);
    await tor.close();
  } finally {
    await site.close();
  }
});

test('a site without a proxy is fetched directly, and one whose proxy cannot start fails the fetch', async () => {
  const site = await startSite([200]);
  try {
    const direct = crawler({ proxyType: null, proxyCountry: null });
    expect((await direct.fetchPage(`${site.url}/page`)).statusCode).toBe(200);
    expect(torm.calls).toEqual([]);

    delete process.env.TORM_URL;
    const tor = crawler({ proxyType: 'tor', proxyCountry: 'AU' });
    await expect(tor.fetchPage(`${site.url}/page`)).rejects.toThrow(ProxyError);
    expect(site.hits).toEqual(['/robots.txt', '/page']);
  } finally {
    await site.close();
  }
});
