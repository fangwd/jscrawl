// The proxy a site's requests go through. `tor` sites fetch through Tor
// instances that torm (github.com/fangwd/torm) runs on this machine, pinned to
// the site's country: a crawl process starts its own instance and stops it when
// it ends; the tool server shares one instance per country across tool calls
// and stops it once idle. torm is optional: only a site that asks for a proxy
// needs TORM_URL and TORM_TOKEN.

import { request } from 'yareq';
import type { CrawlerOptions, ProxyType } from './models';

export const PROXY_TYPES: readonly ProxyType[] = ['tor'];

export interface ProxySpec {
  type: ProxyType;
  /** ISO 3166-1 alpha-2, uppercase; null: any exit. */
  country: string | null;
}

/** The site's requests cannot go through its proxy: fatal to the crawl, never a page failure. */
export class ProxyError extends Error {}

/** A route out for a site's requests, which can be renewed or replaced when it fails. */
export interface Proxy {
  /** For yareq: `socks5h://` so host names resolve at the exit. */
  readonly url: string;
  /** For logs: `tor AU #3`. */
  readonly label: string;
  /** Bumped by every renewal and replacement; a browser launched on an older one reconnects. */
  readonly generation: number;
  /** A new exit (a new Tor identity); concurrent calls share one renewal. */
  renew(): Promise<void>;
  /** A fresh instance, for one that stopped answering. */
  replace(): Promise<void>;
  /** Whether `error` says the proxy itself is down rather than the route through it. */
  isDown(error: unknown): boolean;
}

export interface ProxySource {
  get(spec: ProxySpec): Promise<Proxy>;
  release(proxy: Proxy): Promise<void>;
}

/** A site's proxy as configured, or null when it is fetched directly. */
export function proxySpec(options: Pick<CrawlerOptions, 'proxyType' | 'proxyCountry'>): ProxySpec | null {
  return options.proxyType ? { type: options.proxyType, country: options.proxyCountry?.trim().toUpperCase() || null } : null;
}

/** A crawler module's `site.proxy`, validated; `where` names it in the error. */
export function parseProxy(where: string, value: unknown): ProxySpec | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object') throw new Error(`${where}: proxy must be an object, e.g. { type: 'tor', country: 'AU' }`);
  const { type, country, ...rest } = value as { type?: unknown; country?: unknown };
  if (!PROXY_TYPES.includes(type as ProxyType)) {
    throw new Error(`${where}: proxy.type must be one of ${PROXY_TYPES.join(', ')}`);
  }
  if (Object.keys(rest).length) throw new Error(`${where}: proxy takes type and country only`);
  if (country !== undefined && (typeof country !== 'string' || !/^[A-Za-z]{2}$/.test(country))) {
    throw new Error(`${where}: proxy.country must be a two-letter country code, e.g. 'AU'`);
  }
  return { type: type as ProxyType, country: country === undefined ? null : (country as string).toUpperCase() };
}

/** What torm reports about an instance (see torm's InstanceInfo). */
interface TormInstance {
  slot?: number;
  pid: number;
  socksAddr: string;
  socksPort: number;
  owner?: string;
  exitCountry?: string;
}

/** torm's HTTP API. */
export class Torm {
  constructor(private readonly base: string, private readonly token: string) {}

  /** The torm the environment names, or null when it names none. */
  static fromEnv(): Torm | null {
    const base = process.env.TORM_URL;
    const token = process.env.TORM_TOKEN;
    return base && token ? new Torm(base.replace(/\/+$/, ''), token) : null;
  }

  private async call<T>(method: string, path: string, json?: unknown): Promise<T> {
    let response;
    try {
      response = await request(`${this.base}${path}`, {
        method,
        headers: { authorization: `Bearer ${this.token}` },
        ...(json === undefined ? {} : { json }),
        // a start answers once tor has bootstrapped, which can take minutes
        timeout: 300_000,
      });
    } catch (err: any) {
      throw new ProxyError(`torm ${method} ${path}: ${err?.message ?? err}`);
    }
    if (response.statusCode >= 300) {
      let error = response.text();
      try {
        error = response.json<{ error?: string }>().error ?? error;
      } catch {
        // not JSON
      }
      throw new ProxyError(`torm ${method} ${path}: HTTP ${response.statusCode} ${error}`);
    }
    return response.json<T>();
  }

  start(country: string | null, owner: string): Promise<TormInstance> {
    return this.call('POST', '/instances', { country, strict: true, owner });
  }
  reload(slot: number): Promise<TormInstance> {
    return this.call('POST', `/instances/${slot}/reload`);
  }
  stop(slot: number): Promise<TormInstance> {
    return this.call('DELETE', `/instances/${slot}`);
  }
  list(): Promise<TormInstance[]> {
    return this.call('GET', '/instances');
  }
}

/** Tor allows a new identity at most every 10 seconds; one asked for sooner is delayed. */
export const RENEW_INTERVAL_MS = 10_000;

/** A Tor instance from torm, pinned to a country. */
export class TorProxy implements Proxy {
  generation = 0;
  private renewedAt = 0;
  private pending?: Promise<void>;

  private constructor(
    private readonly torm: Torm,
    private readonly country: string | null,
    private readonly owner: string,
    private instance: TormInstance
  ) {}

  static async start(torm: Torm, country: string | null, owner: string): Promise<TorProxy> {
    return new TorProxy(torm, country, owner, await torm.start(country, owner));
  }

  get slot(): number {
    if (this.instance.slot === undefined) throw new ProxyError(`torm returned an instance without a slot (pid ${this.instance.pid})`);
    return this.instance.slot;
  }
  get url(): string {
    return `socks5h://${this.instance.socksAddr}:${this.instance.socksPort}`;
  }
  get label(): string {
    return `tor ${this.country ?? 'any'} #${this.instance.slot ?? '?'}`;
  }

  renew(): Promise<void> {
    return this.once(async () => {
      const wait = this.renewedAt + RENEW_INTERVAL_MS - Date.now();
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      await this.torm.reload(this.slot);
      this.renewedAt = Date.now();
      this.generation++;
    });
  }

  replace(): Promise<void> {
    return this.once(async () => {
      await this.torm.stop(this.slot).catch(() => undefined);
      this.instance = await this.torm.start(this.country, this.owner);
      this.renewedAt = Date.now();
      this.generation++;
    });
  }

  /** Refused at the instance's own SOCKS port: tor is gone. The SOCKS client reports it in its message only. */
  isDown(error: any): boolean {
    const port = this.instance.socksPort;
    return (
      (error?.code === 'ECONNREFUSED' && Number(error?.port) === port) ||
      new RegExp(`ECONNREFUSED \\S+:${port}\\b`).test(String(error?.message ?? ''))
    );
  }

  stop(): Promise<unknown> {
    return this.torm.stop(this.slot).catch(() => undefined);
  }

  /** Runs one renewal or replacement at a time; callers arriving meanwhile share it. */
  private once(change: () => Promise<void>): Promise<void> {
    return (this.pending ??= change().finally(() => (this.pending = undefined)));
  }
}

function requireTorm(): Torm {
  const torm = Torm.fromEnv();
  if (!torm) throw new ProxyError('This site fetches through Tor: set TORM_URL and TORM_TOKEN to a running torm');
  return torm;
}

/** One instance per `get`, stopped on `release`: a crawl process's own. */
export class LeasedProxies implements ProxySource {
  constructor(private readonly owner: string) {}

  async get(spec: ProxySpec): Promise<Proxy> {
    return TorProxy.start(requireTorm(), spec.country, this.owner);
  }

  async release(proxy: Proxy): Promise<void> {
    if (proxy instanceof TorProxy) await proxy.stop();
  }
}

/** The tool server's instances: one per country, shared by every call, stopped after `idleMs` unused. */
export class ProxyPool implements ProxySource {
  static readonly OWNER = 'jscrawl:tools';
  private entries = new Map<string, { proxy: Promise<TorProxy>; usedAt: number }>();
  private sweeper: NodeJS.Timeout;

  constructor(private readonly idleMs = 15 * 60_000) {
    this.sweeper = setInterval(() => void this.sweep(), Math.min(idleMs, 60_000));
    this.sweeper.unref();
  }

  async get(spec: ProxySpec): Promise<Proxy> {
    const key = `${spec.type}:${spec.country ?? '*'}`;
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { proxy: TorProxy.start(requireTorm(), spec.country, ProxyPool.OWNER), usedAt: Date.now() };
      this.entries.set(key, entry);
      // a failed start is not kept: the next call tries again
      entry.proxy.catch(() => this.entries.delete(key));
    }
    entry.usedAt = Date.now();
    return entry.proxy;
  }

  async release(): Promise<void> {}

  /** Stops the instances no call has used for `idleMs`. */
  async sweep(now = Date.now()): Promise<void> {
    for (const [key, entry] of this.entries) {
      if (now - entry.usedAt < this.idleMs) continue;
      this.entries.delete(key);
      await entry.proxy.then((proxy) => proxy.stop()).catch(() => undefined);
    }
  }

  /** Stops this pool's instances. */
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
  onRetry: (retry: number, failure: string, down: boolean) => void = () => {}
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

/** A crawl's proxy, shared by its crawlers: started with the first request, null when fetched directly. */
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

/** Where this process's crawlers get their proxies; by default each its own instance. */
export function proxies(): ProxySource {
  return (source ??= new LeasedProxies(processOwner()));
}

/** The owner torm records for this process's instances: its crawl run, else its pid. */
export function processOwner(): string {
  const run = process.env.JSCRAWL_RUN_ID;
  return run ? `jscrawl:run:${run}` : `jscrawl:pid:${process.pid}`;
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err?.code === 'EPERM';
  }
};

/**
 * Stops the instances jscrawl processes left behind: a process that is gone,
 * with `runs` a crawl run not among them, and with `tools` every tool server's.
 * Without torm configured there is nothing to do. Returns how many it stopped.
 */
export async function reapProxies({ runs, tools = false }: { runs?: Set<number>; tools?: boolean }): Promise<number> {
  const torm = Torm.fromEnv();
  if (!torm) return 0;
  let stopped = 0;
  for (const instance of await torm.list()) {
    const owner = instance.owner ?? '';
    const run = /^jscrawl:run:(\d+)$/.exec(owner);
    const pid = /^jscrawl:pid:(\d+)$/.exec(owner);
    const left =
      (run && runs && !runs.has(Number(run[1]))) || (pid && !alive(Number(pid[1]))) || (tools && owner === ProxyPool.OWNER);
    if (left && instance.slot !== undefined) {
      await torm.stop(instance.slot).catch(() => undefined);
      stopped++;
    }
  }
  return stopped;
}
