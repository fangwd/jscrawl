import * as crypto from 'crypto';

import { Database } from 'sqlex';

import { domain } from './domain';
import { Config, Site } from './models';
import { siteModule } from './sites';

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timeoutId = setTimeout(() => {
      clearTimeout(timeoutId);
      resolve();
    }, ms);
  });
}

export function sha1(data: string | Buffer): string {
  return crypto.createHash('sha1').update(data).digest('hex');
}

export function trimTitle(title: string): string {
  return title.trim().replace(/\s+/g, ' ').replace(/\s+,/g, ',');
}

/** Finds the most specific seed containing a URL, matching hosts with or without www. */
export function siteForUrl<T>(
  urlString: string,
  sites: readonly T[],
  seedUrl: (site: T) => string | null,
): T | undefined {
  if (!URL.canParse(urlString)) return undefined;
  const target = new URL(urlString);
  const host = (url: URL) => url.host.toLowerCase().replace(/^www\./, '');
  let match: T | undefined;
  let longest = -1;
  for (const site of sites) {
    const seed = seedUrl(site);
    if (!seed || !URL.canParse(seed)) continue;
    const url = new URL(seed);
    if (host(url) !== host(target)) continue;
    const path = url.pathname.replace(/\/+$/, '');
    if (target.pathname !== path && !target.pathname.startsWith(`${path}/`)) continue;
    if (path.length > longest) {
      match = site;
      longest = path.length;
    }
  }
  return match;
}

/** The name of the site whose seed contains this URL, preferring the longest matching path. */
export async function getUrlSite(db: Database, urlString: string): Promise<string> {
  const seeds = await db
    .table('url')
    .select({ site: { fields: ['name'] } }, { where: { type: 'seed' } });
  const seed = siteForUrl(urlString, seeds, (row) => row.url as string);
  if (!seed) {
    throw new Error(`Site not found for url: ${urlString}`);
  }
  return (seed.site as { name: string }).name;
}

export async function getDatabase(config: Config) {
  const db = new Database(config.database);
  await db.buildSchema();
  return db;
}

export async function getCrawler(config: Config, site: string | Site) {
  if (typeof site === 'string') {
    if (/^https?:/i.test(site)) {
      const db = await getDatabase(config);
      site = await getUrlSite(db, site);
      await db.end();
    }
  } else {
    site = site.name;
  }
  const Plugin = siteModule(site, config).default;
  const db = new (domain().database)(config.database);
  await db.init(site);
  return new Plugin(db, config);
}
