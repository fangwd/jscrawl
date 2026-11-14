// The proxy a site's requests go through. A site that names a proxy type in
// its crawler's `site.proxy` fetches through proxies from the deployment's
// proxy provider: a service that implements docs/proxy-provider.md, named by
// PROXY_PROVIDER_URL and PROXY_PROVIDER_TOKEN. A crawl process takes its own
// proxy and removes it when it ends; the tool server shares one per type and
// country across tool calls and removes it once idle. Only a site that asks
// for a proxy needs a provider.

import { request } from 'yareq';

import type { CrawlerOptions } from './models';

export interface ProxySpec {
  /** A proxy type the provider offers; jscrawl does not interpret it. */
  type: string;
  /** ISO 3166-1 alpha-2, uppercase; null: any country. */
  country: string | null;
}

/** The site's requests cannot go through its proxy: fatal to the crawl, never a page failure. */
export class ProxyError extends Error {
  /** The provider's HTTP status, when it answered with an error. */
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

/** A route out for a site's requests, which can be renewed or replaced when it fails. */
export interface Proxy {
  /** For the HTTP client and the browser: `socks5h://`, `socks5://` or `http://`. */
  readonly url: string;
  /** For logs: `<type> <country> #<id>`. */
  readonly label: string;
  /** Bumped by every renewal and replacement; a browser launched on an older one reconnects. */
  readonly generation: number;
  /** A new route out (a new exit); concurrent calls share one renewal. */
  renew(): Promise<void>;
  /** A new proxy, for one that stopped answering. */
  replace(): Promise<void>;
  /** Whether `error` says the proxy itself is down rather than the route through it. */
  isDown(error: unknown): boolean;
}

export interface ProxySource {
  get(spec: ProxySpec): Promise<Proxy>;
  release(proxy: Proxy): Promise<void>;
}

/** A proxy type as a crawler names it, and as the crawler table stores it. */
const PROXY_TYPE = /^[a-z0-9][a-z0-9-]*$/;

/** A site's proxy as configured, or null when it is fetched directly. */
export function proxySpec(
  options: Pick<CrawlerOptions, 'proxyType' | 'proxyCountry'>,
): ProxySpec | null {
  return options.proxyType
    ? {
        type: options.proxyType,
        country: options.proxyCountry?.trim().toUpperCase() || null,
      }
    : null;
}

/** A crawler module's `site.proxy`, validated; `where` names it in the error. */
export function parseProxy(where: string, value: unknown): ProxySpec | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object')
    throw new Error(
      `${where}: proxy must be an object, e.g. { type: 'residential', country: 'AU' }`,
    );
  const { type, country, ...rest } = value as {
    type?: unknown;
    country?: unknown;
  };
  if (typeof type !== 'string' || !PROXY_TYPE.test(type)) {
    throw new Error(
      `${where}: proxy.type must name a type the proxy provider offers (lower-case letters, digits and dashes)`,
    );
  }
  if (Object.keys(rest).length) throw new Error(`${where}: proxy takes type and country only`);
  if (country !== undefined && (typeof country !== 'string' || !/^[A-Za-z]{2}$/.test(country))) {
    throw new Error(`${where}: proxy.country must be a two-letter country code, e.g. 'AU'`);
  }
  return {
    type,
    country: country === undefined ? null : (country as string).toUpperCase(),
  };
}

/** A proxy as the provider describes it (docs/proxy-provider.md). */
export interface ProvidedProxy {
  id: string | number;
  url: string;
  type?: string;
  country?: string | null;
  owner?: string | null;
  /** The provider's word on its health, for one it can report on: `ready`, or why it may not answer. */
  status?: string;
}

/** The proxy provider's HTTP API (docs/proxy-provider.md). */
export class ProxyProvider {
  constructor(
    private readonly base: string,
    private readonly token: string,
  ) {}

  /** The provider the environment names, or null when it names none. */
  static fromEnv(): ProxyProvider | null {
    const base = process.env.PROXY_PROVIDER_URL;
    const token = process.env.PROXY_PROVIDER_TOKEN;
    return base && token ? new ProxyProvider(base.replace(/\/+$/, ''), token) : null;
  }

  /** One API call; a create or renewal may take minutes, as a proxy is answered once usable. */
  private async call<T>(
    method: string,
    path: string,
    json?: unknown,
    timeout = 30_000,
  ): Promise<T> {
    let response;
    try {
      response = await request(`${this.base}${path}`, {
        method,
        headers: { authorization: `Bearer ${this.token}` },
        ...(json === undefined ? {} : { json }),
        timeout,
      });
    } catch (err: any) {
      throw new ProxyError(`proxy provider ${method} ${path}: ${err?.message ?? err}`);
    }
    if (response.statusCode >= 300) {
      let error = response.text();
      try {
        error = response.json<{ error?: string }>().error ?? error;
      } catch {
        // not JSON
      }
      throw new ProxyError(
        `proxy provider ${method} ${path}: HTTP ${response.statusCode} ${error}`,
        response.statusCode,
      );
    }
    return (response.text() ? response.json<T>() : undefined) as T;
  }

  create(spec: ProxySpec, owner: string): Promise<ProvidedProxy> {
    return this.call(
      'POST',
      '/proxies',
      { type: spec.type, country: spec.country, owner },
      300_000,
    );
  }
  renew(id: string | number): Promise<ProvidedProxy> {
    return this.call('POST', `/proxies/${encodeURIComponent(id)}/renew`, undefined, 300_000);
  }
  remove(id: string | number): Promise<void> {
    return this.call('DELETE', `/proxies/${encodeURIComponent(id)}`);
  }
  list(): Promise<ProvidedProxy[]> {
    return this.call('GET', '/proxies');
  }
}

/** A proxy from the provider. */
export class ProviderProxy implements Proxy {
  generation = 0;
  private pending?: Promise<void>;

  private constructor(
    private readonly provider: ProxyProvider,
    private readonly spec: ProxySpec,
    private readonly owner: string,
    private proxy: ProvidedProxy,
  ) {}

  static async create(
    provider: ProxyProvider,
    spec: ProxySpec,
    owner: string,
  ): Promise<ProviderProxy> {
    return new ProviderProxy(provider, spec, owner, await provider.create(spec, owner));
  }

  get url(): string {
    return this.proxy.url;
  }
  get label(): string {
    return `${this.spec.type} ${this.spec.country ?? 'any'} #${this.proxy.id}`;
  }

  renew(): Promise<void> {
    return this.once(async () => {
      this.proxy = {
        ...this.proxy,
        ...(await this.provider.renew(this.proxy.id)),
      };
      this.generation++;
    });
  }

  replace(): Promise<void> {
    return this.once(async () => {
      await this.remove();
      this.proxy = await this.provider.create(this.spec, this.owner);
      this.generation++;
    });
  }

  /** Refused at the proxy's own address: it is gone. A SOCKS client reports that in its message only. */
  isDown(error: any): boolean {
    const url = new URL(this.proxy.url);
    const port = Number(url.port) || (url.protocol === 'http:' ? 80 : 1080);
    return (
      (error?.code === 'ECONNREFUSED' && Number(error?.port) === port) ||
      new RegExp(`ECONNREFUSED \\S+:${port}\\b`).test(String(error?.message ?? ''))
    );
  }

  remove(): Promise<unknown> {
    return this.provider.remove(this.proxy.id).catch(() => undefined);
  }

  /** Runs one renewal or replacement at a time; callers arriving meanwhile share it. */
  private once(change: () => Promise<void>): Promise<void> {
    return (this.pending ??= change().finally(() => (this.pending = undefined)));
  }
}

function requireProvider(): ProxyProvider {
  const provider = ProxyProvider.fromEnv();
  if (!provider)
    throw new ProxyError(
      'This site fetches through a proxy: set PROXY_PROVIDER_URL and PROXY_PROVIDER_TOKEN',
    );
  return provider;
}

/** One proxy per `get`, removed on `release`: a crawl process's own. */
export class LeasedProxies implements ProxySource {
  constructor(private readonly owner: string) {}

  async get(spec: ProxySpec): Promise<Proxy> {
    return ProviderProxy.create(requireProvider(), spec, this.owner);
  }

  async release(proxy: Proxy): Promise<void> {
    if (proxy instanceof ProviderProxy) await proxy.remove();
  }
}

/** The tool server's proxies: one per type and country, shared by every call, removed after `idleMs` unused. */
export class ProxyPool implements ProxySource {
  static readonly OWNER = 'jscrawl:tools';
  private entries = new Map<string, { proxy: Promise<ProviderProxy>; usedAt: number }>();
  private sweeper: NodeJS.Timeout;

  /** `owner` names the proxies' holder to the provider: the tool server's by default, else a process's. */
  constructor(
    private readonly idleMs = 15 * 60_000,
    private readonly owner: string = ProxyPool.OWNER,
  ) {
    this.sweeper = setInterval(() => void this.sweep(), Math.min(idleMs, 60_000));
    this.sweeper.unref();
  }

  async get(spec: ProxySpec): Promise<Proxy> {
    const key = `${spec.type}:${spec.country ?? '*'}`;
    let entry = this.entries.get(key);
    if (!entry) {
      entry = {
        proxy: ProviderProxy.create(requireProvider(), spec, this.owner),
        usedAt: Date.now(),
      };
      this.entries.set(key, entry);
      // a failed create is not kept: the next call tries again
      entry.proxy.catch(() => this.entries.delete(key));
    }
    entry.usedAt = Date.now();
    return entry.proxy;
  }

  async release(): Promise<void> {}

  /** Removes the proxies no call has used for `idleMs`. */
  async sweep(now = Date.now()): Promise<void> {
    for (const [key, entry] of this.entries) {
      if (now - entry.usedAt < this.idleMs) continue;
      this.entries.delete(key);
      await entry.proxy.then((proxy) => proxy.remove()).catch(() => undefined);
    }
  }

  /** Removes this pool's proxies. */
  async close(): Promise<void> {
    clearInterval(this.sweeper);
    await this.sweep(Infinity);
  }
}

/** Statuses an exit IP draws - forbidden, rate-limited, challenged - which a new route may not. */
const RENEWED_STATUSES = new Set([403, 429, 503]);

/** For viaProxy: names a response's status when it is one a new route is worth retrying. */
export function refusedStatus(response: { statusCode: number }): string | null {
  return RENEWED_STATUSES.has(response.statusCode) ? `HTTP ${response.statusCode}` : null;
}

/**
 * Runs `attempt` through `proxy` until it succeeds or `retries` renewals are
 * spent. A thrown error, or a result `refusal` names, first renews the route (a
 * new exit), or replaces the proxy when it is down; `onRetry` hears about each.
 * The last attempt's result or error is the caller's.
 */
export async function viaProxy<T>(
  proxy: Proxy,
  retries: number,
  attempt: () => Promise<T>,
  refusal: (result: T) => string | null = () => null,
  onRetry: (retry: number, failure: string, down: boolean) => void = () => {},
): Promise<T> {
  for (let retry = 1; ; retry++) {
    const last = retry > retries;
    let failure: string | null;
    let down = false;
    try {
      const result = await attempt();
      failure = refusal(result);
      if (last || failure === null) return result;
    } catch (err: any) {
      if (last) throw err;
      down = proxy.isDown(err);
      failure = String(err?.code ?? err?.message ?? err);
    }
    onRetry(retry, failure, down);
    await (down ? proxy.replace() : proxy.renew());
  }
}

/** A crawl's proxy, shared by its crawlers: taken with the first request, null when fetched directly. */
export interface ProxyLease {
  lease?: Promise<Proxy | null>;
}

/** Gives a crawl's proxy back to where it came from; the next request takes a new one. */
export async function releaseLease(holder: ProxyLease): Promise<void> {
  const lease = holder.lease;
  holder.lease = undefined;
  const proxy = await lease?.catch(() => null);
  if (proxy) await proxies().release(proxy);
}

let source: ProxySource | undefined;

/** Sets where this process's crawlers get their proxies (the tool server's pool). */
export function useProxies(proxies: ProxySource): void {
  source = proxies;
}

/** Where this process's crawlers get their proxies; by default each its own. */
export function proxies(): ProxySource {
  return (source ??= new LeasedProxies(processOwner()));
}

/** The owner the provider records for this process's proxies: its crawl run, else its pid. */
export function processOwner(): string {
  const run = process.env.JSCRAWL_RUN_ID;
  return run ? `jscrawl:run:${run}` : `jscrawl:pid:${process.pid}`;
}

export const processAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err?.code === 'EPERM';
  }
};

/** Who holds a proxy, from the owner jscrawl gave it; null for one jscrawl did not create. */
export type ProxyHolder = { run: number } | { pid: number } | { tools: true };

export function proxyHolder(owner: string | null | undefined): ProxyHolder | null {
  const run = /^jscrawl:run:(\d+)$/.exec(owner ?? '');
  if (run) return { run: Number(run[1]) };
  const pid = /^jscrawl:pid:(\d+)$/.exec(owner ?? '');
  if (pid) return { pid: Number(pid[1]) };
  return owner === ProxyPool.OWNER ? { tools: true } : null;
}

/**
 * Removes the proxies jscrawl processes left behind: a process that is gone,
 * with `runs` a crawl run not among them, and with `tools` every tool server's.
 * Without a provider there is nothing to do. Returns how many it removed.
 */
export async function reapProxies({
  runs,
  tools = false,
}: {
  runs?: Set<number>;
  tools?: boolean;
}): Promise<number> {
  const provider = ProxyProvider.fromEnv();
  if (!provider) return 0;
  let removed = 0;
  for (const proxy of await provider.list()) {
    const holder = proxyHolder(proxy.owner);
    const left =
      holder !== null &&
      (('run' in holder && runs && !runs.has(holder.run)) ||
        ('pid' in holder && !processAlive(holder.pid)) ||
        ('tools' in holder && tools));
    if (left) {
      await provider.remove(proxy.id).catch(() => undefined);
      removed++;
    }
  }
  return removed;
}
