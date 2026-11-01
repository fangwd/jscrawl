// The site's own inventory of its urls: robots.txt advertises the sitemaps, a
// sitemap index lists more files, and each file lists urls. Coverage diffs this
// against what the crawler queued, to find urls a classifier missed.

import { gunzipSync } from 'zlib';
import { parseStringPromise } from 'xml2js';
import { request } from 'yareq';
import { REQUEST_HEADERS } from './crawler';

export interface UrlEntry {
  loc: string;
  lastmod: string;
  changefreq: string;
  priority: string;
}

/** Fetches a body as text, transparently for the gzipped sitemaps some sites serve. */
export type Fetcher = (url: string) => Promise<string>;

/** How many files one inventory pulls in, so a broken index cannot loop. */
const MAX_FILES = 50;

export async function fetchText(url: string, signal?: AbortSignal): Promise<string> {
  const response = await request(url, {
    headers: REQUEST_HEADERS,
    redirect: 'follow',
    timeout: 30_000,
    signal: AbortSignal.any([AbortSignal.timeout(30_000), ...(signal ? [signal] : [])]),
    responseType: 'buffer',
    retry: { retries: 2, delay: ({ attempt }: { attempt: number }) => 2000 * attempt },
  });
  const body = response.body as Buffer;
  return (url.endsWith('.gz') ? gunzipSync(body) : body).toString('utf8');
}

export async function parseSitemap(xml: string): Promise<UrlEntry[]> {
  const urlset = (await parseXml(xml))?.urlset;
  const entries = Array.isArray(urlset?.url) ? urlset.url : [];
  return entries.map((entry: any) => {
    const url: { [key: string]: string } = {};
    for (const name in entry) url[name] = first(entry[name]);
    return url as unknown as UrlEntry;
  });
}

/** The sitemaps a `<sitemapindex>` lists; empty for a plain urlset. */
export async function parseSitemapIndex(xml: string): Promise<string[]> {
  const children = (await parseXml(xml))?.sitemapindex?.sitemap;
  return (Array.isArray(children) ? children : []).map((child: any) => first(child?.loc)).filter(Boolean);
}

async function parseXml(xml: string): Promise<any> {
  try {
    return await parseStringPromise(xml);
  } catch {
    return undefined; // not a sitemap: a html error page, or truncated xml
  }
}

/** xml2js wraps every element in an array. */
function first(value: unknown): string {
  const one = Array.isArray(value) ? value[0] : value;
  return one === undefined || one === null ? '' : String(typeof one === 'object' ? (one as any)._ ?? '' : one).trim();
}

export interface SitemapFile {
  url: string;
  urls: string[];
}

/** The sitemaps robots.txt advertises, or the conventional `/sitemap.xml`. */
export async function sitemapFiles(seedUrl: string, fetch: Fetcher): Promise<string[]> {
  const origin = new URL(seedUrl).origin;
  let advertised: string[] = [];
  try {
    const robots = await fetch(`${origin}/robots.txt`);
    advertised = [...robots.matchAll(/^\s*sitemap:\s*(\S+)/gim)].map((match) => match[1]);
  } catch {
    // no robots.txt: fall back to the conventional path
  }
  return [...new Set(advertised.length ? advertised : [`${origin}/sitemap.xml`])].slice(0, MAX_FILES);
}

/** Every url the site's sitemaps list, by file, following sitemap indexes. */
export async function sitemapInventory(seedUrl: string, fetch: Fetcher = fetchText): Promise<SitemapFile[]> {
  const pending = await sitemapFiles(seedUrl, fetch);
  const seen = new Set<string>();
  const inventory: SitemapFile[] = [];
  while (pending.length && inventory.length < MAX_FILES) {
    const file = pending.shift()!;
    if (seen.has(file)) continue;
    seen.add(file);
    let xml: string;
    try {
      xml = await fetch(file);
    } catch {
      continue; // an unreachable sitemap is a hole in the inventory, not an error
    }
    const children = await parseSitemapIndex(xml);
    if (children.length) {
      pending.push(...children.slice(0, MAX_FILES));
      continue;
    }
    inventory.push({ url: file, urls: (await parseSitemap(xml)).map((entry) => entry.loc).filter(Boolean) });
  }
  return inventory;
}
