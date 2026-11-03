// The checks any domain's database class must pass (separate-core-app-impl.md
// §9): the write protocol a crawl relies on, stated as executable tests. Framework-
// free: each check throws on failure, and a test file maps them to its runner.

import { CoreDatabase } from '../base-database';
import { SiteUrl } from '../models';

export interface Conformance {
  /** A database on the test connection, not yet initialised; the kit registers the site and calls init. */
  database(): CoreDatabase;
  /** Buffers one page's worth of the domain's records, as a scrape of `url` would. */
  page(db: CoreDatabase, url: SiteUrl): void;
  /** The domain's tables `page` writes, counted to see what a flush did. */
  tables: string[];
  /** Those of `tables` that record an observation per scrape (a price history): they grow on every flush by design. */
  history?: string[];
}

export interface Check {
  name: string;
  run(): Promise<void>;
}

const SITE = 'conformance';

async function fresh(c: Conformance): Promise<{ db: CoreDatabase; url: SiteUrl }> {
  const db = c.database();
  await db.buildSchema();
  await db.zap();
  const crawler = db.table('crawler').append({ name: SITE });
  const site = db.table('site').append({ name: SITE, crawler, currency: 'AUD' });
  db.table('url').append({ site, url: 'https://conformance.test/page', hash: 'conformance-page', type: 'seed' });
  await db.flush();
  db.clear();
  await db.init(SITE);
  const url = (await db.table('url').select({ site: '*' }))[0] as unknown as SiteUrl;
  // as scrape() does before handing the page over: relative links resolve against it
  db.baseUrl = url.url;
  return { db, url };
}

async function counts(db: CoreDatabase, tables: string[]): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const table of tables) {
    const [row] = await db.query<{ n: string }[]>(`select count(*) as n from ${table}`);
    out[table] = Number(row.n);
  }
  return out;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

/** The checks, to be run in order by the domain's test file; each starts from an empty database. */
export function databaseConformance(c: Conformance): Check[] {
  return [
    {
      name: 'a page flushes every record it buffered and leaves nothing behind in the buffer',
      async run() {
        const { db, url } = await fresh(c);
        try {
          c.page(db, url);
          assert(db.stats() !== '', 'page() buffered nothing');
          await db.flush();
          db.clear();
          assert(db.stats() === '', `records remain buffered after flush and clear: ${db.stats()}`);
          const written = await counts(db, c.tables);
          const empty = c.tables.filter((table) => written[table] === 0);
          assert(empty.length === 0, `flush wrote no rows to ${empty.join(', ')} (page() names every table it writes)`);
        } finally {
          await db.end();
        }
      },
    },
    {
      name: 'a preview (buffer, then clear without a flush) leaves no rows',
      async run() {
        const { db, url } = await fresh(c);
        try {
          const before = await counts(db, c.tables);
          c.page(db, url);
          db.clear();
          const after = await counts(db, c.tables);
          assert(JSON.stringify(after) === JSON.stringify(before), `a cleared buffer changed rows: ${JSON.stringify(after)}`);
        } finally {
          await db.end();
        }
      },
    },
    {
      name: 'flushing the same page twice leaves the same rows, but for the observations it records',
      async run() {
        const { db, url } = await fresh(c);
        try {
          c.page(db, url);
          await db.flush();
          db.clear();
          const once = await counts(db, c.tables);
          c.page(db, url);
          await db.flush();
          db.clear();
          const twice = await counts(db, c.tables);
          for (const table of c.tables) {
            if (c.history?.includes(table)) {
              assert(twice[table] >= once[table], `${table} is a history table but shrank: ${once[table]} -> ${twice[table]}`);
            } else {
              assert(twice[table] === once[table], `a second flush of the same page changed ${table}: ${once[table]} -> ${twice[table]}`);
            }
          }
        } finally {
          await db.end();
        }
      },
    },
    {
      name: 'a clone shares the site and queues urls as its original would',
      async run() {
        const { db, url } = await fresh(c);
        try {
          const clone = db.clone();
          assert(clone.constructor === db.constructor, 'clone() must construct the domain database class');
          assert(clone.site === db.site, 'clone() must share the site');
          c.page(clone, url);
          await clone.flush();
          clone.clear();
          const written = await counts(db, c.tables);
          assert(
            Object.values(written).some((n) => n > 0),
            'a clone flushed nothing'
          );
        } finally {
          await db.end();
        }
      },
    },
    {
      name: 'a url type the domain did not declare is rejected',
      async run() {
        const { db } = await fresh(c);
        try {
          let threw = false;
          try {
            db.addUrl('https://conformance.test/other', 'undeclared-type', null);
          } catch {
            threw = true;
          }
          assert(threw, 'addUrl accepted an undeclared url type');
        } finally {
          await db.end();
        }
      },
    },
  ];
}
