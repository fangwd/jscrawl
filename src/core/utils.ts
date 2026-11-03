import * as crypto from 'crypto';
import { domain } from './domain';
import { siteModule } from './sites';
import { Config, Site } from './models';
import { Database, Filter } from 'sqlex';

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

/** The name of the site whose seed urls share the url's host. */
export async function getUrlSite(db: Database, urlString: string): Promise<string> {
  const host = new URL(urlString).host;
  const seeds = await db
    .table('url')
    .select({ site: { fields: ['name'] } }, { where: { type: 'seed' } });
  const seed = seeds.find((row) => new URL(row.url as string).host === host);
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
