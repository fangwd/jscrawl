// The structured "what the crawl knows about one url" report, shared by the
// agent's inspectUrl tool (which renders it as text) and the web API (which
// serves it as JSON): the url row, its latest fetch and what it queued. What
// the page produced is the domain's report (its inspect tool, named by
// DomainConfig.inspectTool). All queries are read-only.

import { readdir } from 'fs/promises';

import { Database } from 'sqlex';

import { PageSnapshots } from './models';
import { sha1 } from './utils';

// url.status meanings (see UrlStatus in src/core/models.ts).
export const URL_STATUS: { [code: number]: string } = {
  [-2]: 'scrape failed',
  [-1]: 'fetch failed',
  0: 'idle',
  1: 'busy',
  2: 'done',
  3: 'disallowed',
};

export interface UrlInfo {
  id: number;
  url: string;
  type: string;
  status: number;
  version: number;
  visitTime: Date | null;
  siteId: number;
  siteName: string;
  currency: string | null;
  locale: string | null;
  pageSnapshots: PageSnapshots;
}

export interface FetchInfo {
  fetchTime: Date;
  httpStatus: number | null;
  finalUrl: string | null;
  error: string | null;
  contentType: string | null;
  contentLength: number | null;
}

export interface UrlReport {
  url: UrlInfo;
  lastFetch: FetchInfo | null;
  /** Urls this page queued (url_graph out-edges): what a listing page produced. */
  queued: { id: number; url: string; type: string; status: number }[];
}

export type Query = <T = any[]>(statement: string, ...args: unknown[]) => Promise<T>;

export const num = (value: unknown): number | null =>
  value === null || value === undefined ? null : Number(value);

export function group<T>(rows: T[], key: (row: T) => number): Map<number, T[]> {
  const map = new Map<number, T[]>();
  for (const row of rows) {
    const k = key(row);
    const list = map.get(k);
    if (list) list.push(row);
    else map.set(k, [row]);
  }
  return map;
}

/** Runs `read` in a read-only transaction with a statement timeout, honouring `signal` between queries. */
export function readOnly<T>(
  db: Database,
  signal: AbortSignal | undefined,
  read: (query: Query) => Promise<T>,
): Promise<T> {
  return db.transaction(async (c) => {
    // the database enforces read-only, whatever the query does
    await c.query('set transaction read only');
    await c.query("set local statement_timeout = '30s'");
    const query: Query = async (statement, ...args) => {
      signal?.throwIfAborted();
      const rows = await c.query(statement, ...args);
      signal?.throwIfAborted();
      return rows as any;
    };
    return read(query);
  });
}

/** The url row's id, by url string or numeric id; null when unknown. */
export async function urlId(db: Database, target: string | number): Promise<number | null> {
  const isId = /^\d+$/.test(String(target));
  const [row] = await db.query<{ id: number }[]>(
    `select id from url where ${isId ? 'id' : 'hash'} = ?`,
    isId ? Number(target) : sha1(String(target)),
  );
  return row ? Number(row.id) : null;
}

/** Everything the crawl knows about one url (by url string or numeric id); null when unknown. */
export async function inspectUrl(
  db: Database,
  target: string | number,
  signal?: AbortSignal,
): Promise<UrlReport | null> {
  const isId = /^\d+$/.test(String(target));
  const data = await readOnly(db, signal, async (query) => {
    const [url] = await query<any[]>(
      `select u.id, u.site_id, u.type, u.status, u.version, u.url, u.visit_time,
              s.name as site_name, s.currency, s.locale, c.page_snapshots
         from url u join site s on s.id = u.site_id
         left join crawler c on c.id = s.crawler_id
        where ${isId ? 'u.id' : 'u.hash'} = ?`,
      isId ? Number(target) : sha1(String(target)),
    );
    if (!url) return null;
    const id = url.id;
    const [fetch] = await query<any[]>(
      `select fetch_time, http_status, final_url, error, content_type, content_length
         from url_fetch where url_id = ? order by fetch_time desc limit 1`,
      id,
    );
    const queued = await query<any[]>(
      `select d.id, d.url, d.type, d.status
         from url_graph g join url d on d.id = g.dst_id
        where g.src_id = ? order by d.id limit 100`,
      id,
    );
    return { url, fetch, queued };
  });

  if (!data) return null;

  const { url: u, fetch: f } = data;
  return {
    url: {
      id: Number(u.id),
      url: u.url,
      type: u.type,
      status: u.status,
      version: u.version,
      visitTime: u.visit_time ?? null,
      siteId: Number(u.site_id),
      siteName: u.site_name,
      currency: u.currency?.trim() ? u.currency.trim() : null,
      locale: u.locale,
      pageSnapshots: u.page_snapshots ?? 'gzip',
    },
    lastFetch: f
      ? {
          fetchTime: f.fetch_time,
          httpStatus: num(f.http_status),
          finalUrl: f.final_url ?? null,
          error: f.error ?? null,
          contentType: f.content_type ?? null,
          contentLength: num(f.content_length),
        }
      : null,
    queued: data.queued.map((d) => ({
      id: Number(d.id),
      url: d.url,
      type: d.type,
      status: d.status,
    })),
  };
}

/** The saved HTML snapshots of a url (`<id>.<version>` file names) in a store directory, sorted. */
export async function listSnapshots(dir: string, urlId: number | string): Promise<string[]> {
  const prefix = `${urlId}.`;
  const names = await readdir(dir).catch(() => [] as string[]);
  // a snapshot's `.fetches` directory holds what its scrape fetched, not a page
  return names.filter((name) => name.startsWith(prefix) && !name.endsWith('.fetches')).sort();
}
