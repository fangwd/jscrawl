// The dashboard's view of the proxy provider: the proxies it holds, who holds
// each (a crawl run, the agent's tools, a CLI process), and the sites that
// fetch through one; renewing, removing and checking where a proxy's requests
// come out.

import { Database } from 'sqlex';
import { request } from 'yareq';
import { processAlive, proxyHolder, ProxyError, ProxyProvider } from '../../core/proxy';

/** What answers with the caller's IP and country as `{"ip": ..., "country": "AU"}`. */
const CHECK_URL = () => process.env.PROXY_CHECK_URL || 'https://ipinfo.io/json';

export type Holder =
  | { kind: 'run'; runId: number; siteId: number | null; siteName: string | null; status: string | null }
  | { kind: 'process'; pid: number }
  | { kind: 'tools' }
  | { kind: 'other'; owner: string | null };

export interface ProxyView {
  id: string | number;
  type: string | null;
  country: string | null;
  holder: Holder;
  /** Its holder is gone: a finished run or a dead process. */
  leftover: boolean;
}

export interface ProxiesOverview {
  /** PROXY_PROVIDER_URL and PROXY_PROVIDER_TOKEN are set. */
  configured: boolean;
  /** The provider could not be listed. */
  error?: string;
  proxies: ProxyView[];
  /** The sites whose crawler names a proxy. */
  sites: { id: number; name: string; type: string; country: string | null }[];
}

export async function proxiesOverview(db: Pick<Database, 'query'>): Promise<ProxiesOverview> {
  const sites = await db.query<{ id: number; name: string; type: string; country: string | null }[]>(
    `select s.id, s.name, c.proxy_type as type, c.proxy_country as country
       from site s join crawler c on c.id = s.crawler_id
      where c.proxy_type is not null
      order by s.name`
  );
  const provider = ProxyProvider.fromEnv();
  if (!provider) return { configured: false, proxies: [], sites };
  let listed;
  try {
    listed = await provider.list();
  } catch (err: any) {
    return { configured: true, error: String(err?.message ?? err), proxies: [], sites };
  }
  const holders = listed.map((proxy) => proxyHolder(proxy.owner));
  const runIds = holders.flatMap((holder) => (holder && 'run' in holder ? [holder.run] : []));
  const runs = runIds.length
    ? await db.query<{ id: number; status: string; site_id: number; site_name: string }[]>(
        `select r.id, r.status, s.id as site_id, s.name as site_name
           from crawler_run r join site s on s.id = r.site_id
          where r.id in (${runIds.map(() => '?').join(', ')})`,
        ...runIds
      )
    : [];
  const proxies = listed.map((proxy, index): ProxyView => {
    const holder = holders[index];
    const base = { id: proxy.id, type: proxy.type ?? null, country: proxy.country ?? null };
    if (holder && 'run' in holder) {
      const run = runs.find((row) => Number(row.id) === holder.run);
      return {
        ...base,
        holder: {
          kind: 'run',
          runId: holder.run,
          siteId: run ? Number(run.site_id) : null,
          siteName: run?.site_name ?? null,
          status: run?.status ?? null,
        },
        leftover: run?.status !== 'running',
      };
    }
    if (holder && 'pid' in holder) return { ...base, holder: { kind: 'process', pid: holder.pid }, leftover: !processAlive(holder.pid) };
    if (holder) return { ...base, holder: { kind: 'tools' }, leftover: false };
    return { ...base, holder: { kind: 'other', owner: proxy.owner ?? null }, leftover: false };
  });
  return { configured: true, proxies, sites };
}

/** An action's outcome as the route answers it. */
type Outcome = { status: number; body?: unknown };

/** A provider failure as an answer: its own 404 stays one, anything else is the gateway's fault. */
function failed(err: unknown): Outcome {
  if (!(err instanceof ProxyError)) throw err;
  return { status: err.status === 404 ? 404 : 502, body: { error: err.message } };
}

const NO_PROVIDER: Outcome = { status: 404, body: { error: 'No proxy provider is configured' } };

export async function renewProxy(id: string): Promise<Outcome> {
  const p = ProxyProvider.fromEnv();
  if (!p) return NO_PROVIDER;
  try {
    const { url: _url, ...proxy } = await p.renew(id);
    return { status: 200, body: proxy };
  } catch (err) {
    return failed(err);
  }
}

export async function removeProxy(id: string): Promise<Outcome> {
  const p = ProxyProvider.fromEnv();
  if (!p) return NO_PROVIDER;
  try {
    await p.remove(id);
    return { status: 204 };
  } catch (err) {
    return failed(err);
  }
}

/** Where a proxy's requests come out: the IP and country PROXY_CHECK_URL sees through it. */
export async function checkProxy(id: string): Promise<Outcome> {
  const p = ProxyProvider.fromEnv();
  if (!p) return NO_PROVIDER;
  let proxy;
  try {
    proxy = (await p.list()).find((candidate) => String(candidate.id) === id);
  } catch (err) {
    return failed(err);
  }
  if (!proxy) return { status: 404, body: { error: `No proxy ${id}` } };
  const checkUrl = CHECK_URL();
  const started = Date.now();
  try {
    const response = await request(checkUrl, { proxy: proxy.url, timeout: 30_000 });
    const answer = response.json<{ ip?: unknown; country?: unknown }>();
    return {
      status: 200,
      body: {
        ip: typeof answer.ip === 'string' ? answer.ip : null,
        country: typeof answer.country === 'string' ? answer.country.toUpperCase() : null,
        expected: proxy.country ?? null,
        ms: Date.now() - started,
        checkUrl,
      },
    };
  } catch (err: any) {
    return { status: 502, body: { error: `${checkUrl} through proxy ${id}: ${err?.message ?? err}` } };
  }
}
