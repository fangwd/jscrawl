// What the crawl holds of sites whose crawler module is gone from the crawlers
// directory, and removing it: the site's database rows (its urls and everything
// recorded from them, its runs, its crawler row), its saved pages and images,
// its crawl logs and its test pages. `--sync` runs it after registering every
// module that is there.

import { existsSync, readdirSync } from 'fs';
import { readdir, rm } from 'fs/promises';
import { join, resolve } from 'path';
import { Database } from 'sqlex';
import { Config } from './models';
import { siteNames, sitesDir } from './sites';

type Db = Pick<Database, 'query' | 'transaction'>;

/** A site, crawler row or fixture directory with no crawler module of its name. */
export interface StaleSite {
  name: string;
  siteId: number | null;
  crawlerId: number | null;
  urls: number;
  /** A crawl of it is running: it is left alone until stopped. */
  running: boolean;
  /** Its test pages, when they are still there. */
  fixtures: string | null;
}

/**
 * Every name the database or the fixtures hold without a crawler module. An
 * empty crawlers directory is an error rather than a reason to remove them all.
 */
export async function staleSites(db: Pick<Database, 'query'>, config: Config): Promise<StaleSite[]> {
  const modules = new Set(siteNames(config));
  if (modules.size === 0) throw new Error(`No site modules in ${sitesDir(config)}: nothing is removed against an empty crawlers directory`);

  const stale = new Map<string, StaleSite>();
  const entry = (name: string) => {
    let site = stale.get(name);
    if (!site) stale.set(name, (site = { name, siteId: null, crawlerId: null, urls: 0, running: false, fixtures: null }));
    return site;
  };
  const sites = await db.query<{ id: number; name: string; crawler_id: number | null; urls: number; running: boolean }[]>(
    `select s.id, s.name, s.crawler_id,
            (select count(*) from url u where u.site_id = s.id) as urls,
            exists (select 1 from crawler_run r where r.site_id = s.id and r.status = 'running') as running
       from site s`
  );
  for (const row of sites.filter((row) => !modules.has(row.name))) {
    Object.assign(entry(row.name), {
      siteId: Number(row.id),
      crawlerId: row.crawler_id === null ? null : Number(row.crawler_id),
      urls: Number(row.urls),
      running: Boolean(row.running),
    });
  }
  const crawlers = await db.query<{ id: number; name: string }[]>(
    'select c.id, c.name from crawler c where not exists (select 1 from site s where s.crawler_id = c.id)'
  );
  for (const row of crawlers.filter((row) => !modules.has(row.name))) entry(row.name).crawlerId = Number(row.id);

  const fixtures = resolve(sitesDir(config), 'fixtures');
  if (existsSync(fixtures)) {
    for (const dir of readdirSync(fixtures, { withFileTypes: true })) {
      if (dir.isDirectory() && !modules.has(dir.name)) entry(dir.name).fixtures = join(fixtures, dir.name);
    }
  }
  return [...stale.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Removes a stale site's rows in one transaction, then its files. */
export async function removeSite(db: Db, config: Config, stale: StaleSite): Promise<void> {
  if (stale.running) throw new Error(`A crawl of ${stale.name} is running: stop it first`);
  let urlIds = new Set<number>();
  let logs: string[] = [];
  if (stale.siteId !== null) {
    const siteId = stale.siteId;
    urlIds = new Set((await db.query<{ id: number }[]>('select id from url where site_id = ?', siteId)).map((row) => Number(row.id)));
    logs = (await db.query<{ log_path: string | null }[]>('select log_path from crawler_run where site_id = ?', siteId)).flatMap(
      (row) => (row.log_path ? [row.log_path] : [])
    );
  }
  await db.transaction(async (connection) => {
    if (stale.siteId !== null) {
      // a url's fetches, links, issues and records go with it; the site's own tables with the site
      await connection.query('delete from url where site_id = ?', stale.siteId);
      await connection.query('delete from site where id = ?', stale.siteId);
    }
    if (stale.crawlerId !== null) {
      await connection.query('delete from crawler c where c.id = ? and not exists (select 1 from site s where s.crawler_id = c.id)', stale.crawlerId);
    }
  });
  for (const store of [config.store?.html, config.store?.images]) {
    if (store) await removeStored(store, urlIds);
  }
  for (const log of logs) await rm(log, { force: true });
  if (stale.fixtures) await rm(stale.fixtures, { recursive: true, force: true });
}

/** A store's files of the given urls: `<url id>.<...>`, a saved page with its recorded fetches, or an image. */
async function removeStored(dir: string, urlIds: Set<number>): Promise<void> {
  if (urlIds.size === 0 || !existsSync(dir)) return;
  for (const name of await readdir(dir)) {
    const id = /^(\d+)\./.exec(name)?.[1];
    if (id && urlIds.has(Number(id))) await rm(join(dir, name), { recursive: true, force: true });
  }
}

/** One line on what removing a stale site takes away. */
export function describeStale({ name, siteId, crawlerId, urls, running, fixtures }: StaleSite): string {
  const parts = [
    ...(siteId !== null ? [`site #${siteId} with ${urls.toLocaleString()} url(s), their records, saved pages and crawl logs`] : []),
    ...(siteId === null && crawlerId !== null ? ['its crawler row'] : []),
    ...(fixtures ? [`its test pages (${fixtures})`] : []),
  ];
  return `${name}: ${parts.join('; ')}${running ? ' - a crawl is running, so it is kept until stopped' : ''}`;
}
