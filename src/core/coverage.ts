// Site coverage: the sitemaps a site publishes, against what the crawler queued
// and what each queued page yielded. One read-only call returning counts and a
// few samples per group - enough to see a classifier that missed or mis-typed
// urls, without putting thousands of rows in the agent's context.

import { Database } from 'sqlex';
import { domain } from './domain';
import { URL_STATUS } from './inspect';
import { Fetcher, fetchText, sitemapInventory } from './sitemap';

/** Samples per group, and how many shape groups a report lists. */
const SAMPLES = 3;
const SHAPES = 6;

export interface ShapeGroup {
  shape: string;
  count: number;
  samples: string[];
}

export interface FileCoverage {
  url: string;
  urls: number;
  /** How the site's own urls for this file were typed, when they were queued. */
  byType: Record<string, number>;
  missing: number;
}

export interface Suspects {
  label: string;
  count: number;
  samples: string[];
}

export interface CoverageReport {
  site: { id: number; name: string; scope: string | null };
  queued: { total: number; scraped: number; failed: number; disallowed: number; vouched: number; byType: Record<string, number> };
  sitemaps: { files: FileCoverage[]; urls: number; matched: number; missing: number };
  /** Listed by the site, never queued: a shape the classifier does not recognise. */
  unqueued: ShapeGroup[];
  /** Queued, listed by no sitemap: normal for pages a sitemap omits, unless bulk. */
  unlisted: ShapeGroup[];
  /** Queued with a type the page did not honour; candidates, not verdicts. */
  suspects: Suspects[];
}

/** Compares urls by host and path: query, fragment, trailing slash and `www` are noise. */
export function coverageKey(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
    return `${host}${decodeURIComponent(parsed.pathname).replace(/\/+$/, '') || '/'}`;
  } catch {
    return undefined;
  }
}

/** Groups urls for a report: the first segment literal, deeper ones placeholders. */
export function urlShape(url: string): string {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    path = url;
  }
  const segments = path.split('/').filter(Boolean);
  if (segments.length === 0) return '/';
  if (segments.length === 1) return '/<slug>';
  return `/${segments[0]}/${segments.slice(1).map(() => '*').join('/')}`;
}

/** Biggest-first groups of urls by shape, each with a few samples. */
export function groupByShape(urls: string[], limit = SHAPES): ShapeGroup[] {
  const groups = new Map<string, string[]>();
  for (const url of urls) {
    const shape = urlShape(url);
    const members = groups.get(shape);
    if (members) members.push(url);
    else groups.set(shape, [url]);
  }
  return [...groups.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, limit)
    .map(([shape, members]) => ({ shape, count: members.length, samples: members.slice(0, SAMPLES).map(urlPath) }));
}

/** Coverage of one site: `null` when the site does not exist. */
export async function coverage(
  db: Database,
  site: string | number,
  options: { fetch?: Fetcher; signal?: AbortSignal } = {}
): Promise<CoverageReport | null> {
  type SiteRow = { id: number; name: string; scope: string | null };
  const sites = /^\d+$/.test(String(site))
    ? await db.query<SiteRow[]>('select id, name, scope from site where id = ?', Number(site))
    : await db.query<SiteRow[]>('select id, name, scope from site where name = ?', site);
  if (sites.length === 0) return null;
  const { id: siteId, name, scope } = sites[0];

  const [seed] = await db.query<{ url: string }[]>(
    `select url from url where site_id = ? order by (type = 'seed') desc, id limit 1`,
    siteId
  );
  const queued = await db.query<{ url: string; type: string; status: number; data: string | null }[]>(
    'select url, type, status, data from url where site_id = ?',
    siteId
  );

  const fetch = options.fetch ?? ((target: string) => fetchText(target, options.signal));
  const files = seed ? await sitemapInventory(seed.url, fetch) : [];
  const listed = new Map<string, string>();
  for (const file of files) {
    for (const url of file.urls) {
      const key = coverageKey(url);
      if (key && !listed.has(key)) listed.set(key, url);
    }
  }
  const queuedByKey = new Map<string, { type: string }>();
  for (const row of queued) {
    const key = coverageKey(row.url);
    if (key && !queuedByKey.has(key)) queuedByKey.set(key, row);
  }

  const coverageByFile: FileCoverage[] = files.map((file) => {
    const byType: Record<string, number> = {};
    let missing = 0;
    for (const url of file.urls) {
      const row = queuedByKey.get(coverageKey(url) ?? '');
      if (!row) missing += 1;
      else byType[row.type] = (byType[row.type] ?? 0) + 1;
    }
    return { url: file.url, urls: file.urls.length, byType, missing };
  });

  const unqueued = [...listed.entries()].filter(([key]) => !queuedByKey.has(key)).map(([, url]) => url);
  // Image urls are assets, never sitemap entries, so they cannot be "unlisted".
  const unlisted = queued
    .filter((row) => row.type !== 'image' && !listed.has(coverageKey(row.url) ?? ''))
    .map((row) => row.url);

  const byType: Record<string, number> = {};
  for (const row of queued) byType[row.type] = (byType[row.type] ?? 0) + 1;

  return {
    site: { id: siteId, name, scope },
    queued: {
      total: queued.length,
      scraped: queued.filter((row) => row.status === 2).length,
      failed: queued.filter((row) => row.status < 0).length,
      disallowed: queued.filter((row) => row.status === 3).length,
      vouched: queued.filter((row) => row.data !== null && row.data !== undefined).length,
      byType,
    },
    sitemaps: {
      files: coverageByFile,
      urls: listed.size,
      matched: listed.size - unqueued.length,
      missing: unqueued.length,
    },
    unqueued: groupByShape(unqueued),
    unlisted: groupByShape(unlisted),
    suspects: await (domain().suspects?.(db as any, siteId) ?? Promise.resolve([])),
  };
}

/** A group of candidate pages for a domain's coverage report: `sql` takes the site id and a sample size, and `count(*) over ()` as total. */
export async function suspect(db: Database, label: string, sql: string, siteId: number): Promise<Suspects> {
  const rows = await db.query<{ url: string; status?: number; total: string | number }[]>(sql, siteId, SAMPLES);
  return {
    label,
    count: Number(rows[0]?.total ?? 0),
    samples: rows.map((row) =>
      row.status === undefined ? urlPath(row.url) : `${urlPath(row.url)} (${URL_STATUS[row.status] ?? row.status})`
    ),
  };
}

/** The path of a url, which is all a sample needs once the site is named. */
export function urlPath(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return url;
  }
}
