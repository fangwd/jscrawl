// A site's state at the end of each complete crawl, and what got worse since the
// last one. The catalogue alone hides a broken crawl - a page that starts failing
// keeps its earlier products - so a snapshot also counts the product pages by
// status. A regression becomes an issue (see core/issues.ts).

import { Database } from 'sqlex';
import { catalogueCounts, EXPECTED_FIELDS, ExpectedField } from './expect';

export interface Snapshot {
  takenAt: Date;
  /** Active products with a variant, and how many carry each field. */
  products: number;
  fields: Record<ExpectedField, number>;
  /** Product pages: scraped, and failed at fetch or scrape. */
  pages: { done: number; failed: number };
}

/** Thresholds: a drop this large between two complete crawls is a regression, not churn. */
const PRODUCT_DROP = 0.2;
const SHARE_DROP = 0.1;
/** Below this many products or pages a percentage says little. */
const MIN_COUNT = 10;

/** Records the site's state now; called when a crawl completes. */
export async function takeSnapshot(db: Database, siteId: number): Promise<Snapshot> {
  const counts = await catalogueCounts(db, siteId);
  const [pages] = await db.query<{ done: string; failed: string }[]>(
    `select count(*) filter (where status = 2) as done, count(*) filter (where status < 0) as failed
       from url where site_id = ? and type = 'product'`,
    siteId
  );
  const snapshot: Snapshot = {
    takenAt: new Date(),
    products: counts.products,
    fields: counts.fields,
    pages: { done: Number(pages.done), failed: Number(pages.failed) },
  };
  await db.query(
    'insert into crawl_snapshot (site_id, taken_at, products, fields, pages) values (?, ?, ?, ?, ?)',
    siteId,
    snapshot.takenAt,
    snapshot.products,
    JSON.stringify(snapshot.fields),
    JSON.stringify(snapshot.pages)
  );
  return snapshot;
}

/** The site's snapshots, newest first. */
export async function snapshots(db: Database, siteId: number, limit = 10): Promise<Snapshot[]> {
  const rows = await db.query<any[]>(
    'select taken_at, products, fields, pages from crawl_snapshot where site_id = ? order by taken_at desc, id desc limit ?',
    siteId,
    limit
  );
  return rows.map((row) => ({ takenAt: row.taken_at, products: row.products, fields: row.fields, pages: row.pages }));
}

const percent = (share: number) => `${Math.round(share * 100)}%`;
const WITH: Record<ExpectedField, string> = {
  price: 'a price',
  availability: 'availability',
  image: 'an image',
  category: 'a category',
  description: 'a description',
  brand: 'a brand',
};
const share = (n: number, of: number) => (of ? n / of : 0);

/** What got worse from `before` to `after`, one sentence each; empty when nothing did. */
export function regressions(before: Snapshot, after: Snapshot): string[] {
  const found: string[] = [];
  if (before.products >= MIN_COUNT && after.products < before.products * (1 - PRODUCT_DROP)) {
    found.push(
      `products fell from ${before.products} to ${after.products} ` +
        `(-${percent(1 - after.products / before.products)}) since the last complete crawl`
    );
  }
  const pagesBefore = before.pages.done + before.pages.failed;
  const pagesAfter = after.pages.done + after.pages.failed;
  const failedBefore = share(before.pages.failed, pagesBefore);
  const failedAfter = share(after.pages.failed, pagesAfter);
  if (pagesAfter >= MIN_COUNT && after.pages.failed >= MIN_COUNT && failedAfter - failedBefore >= SHARE_DROP) {
    found.push(
      `failing product pages rose from ${percent(failedBefore)} (${before.pages.failed} of ${pagesBefore}) ` +
        `to ${percent(failedAfter)} (${after.pages.failed} of ${pagesAfter})`
    );
  }
  if (before.products >= MIN_COUNT && after.products >= MIN_COUNT) {
    for (const field of EXPECTED_FIELDS) {
      const was = share(before.fields[field], before.products);
      const now = share(after.fields[field], after.products);
      if (was - now >= SHARE_DROP) {
        found.push(`products with ${WITH[field]} fell from ${percent(was)} to ${percent(now)}`);
      }
    }
  }
  return found;
}
