// A site's state at the end of each complete crawl, and what got worse since the
// last one. The records alone hide a broken crawl - a page that starts failing
// keeps its earlier records - so a snapshot holds the domain's metrics beside
// the count of the domain's pages by status. A regression becomes an issue
// (see issues.ts); the domain declares what counts as one (metricRules).

import { Database } from 'sqlex';
import { domain, RegressionRule } from './domain';

export interface Snapshot {
  takenAt: Date;
  /** The domain's metrics, by name. */
  metrics: Record<string, number>;
  /** The domain's pages: scraped, and failed at fetch or scrape. */
  pages: { done: number; failed: number };
}

/** A rise in the failing share of pages this large between two complete crawls is a regression, not churn. */
const FAILED_SHARE_RISE = 0.1;
/** Below this many of anything a percentage says little. */
const MIN_COUNT = 10;

/** Records the site's state now; called when a crawl completes. */
export async function takeSnapshot(db: Database, siteId: number): Promise<Snapshot> {
  const metrics = await domain().metrics(siteId, db as any);
  const [pages] = await db.query<{ done: string; failed: string }[]>(
    `select count(*) filter (where status = 2) as done, count(*) filter (where status < 0) as failed
       from url where site_id = ? and type in (${domain().urlTypes.map(() => '?').join(', ')})`,
    siteId,
    ...domain().urlTypes
  );
  const snapshot: Snapshot = {
    takenAt: new Date(),
    metrics,
    pages: { done: Number(pages.done), failed: Number(pages.failed) },
  };
  await db.query(
    'insert into crawl_snapshot (site_id, taken_at, metrics, pages) values (?, ?, ?, ?)',
    siteId,
    snapshot.takenAt,
    JSON.stringify(snapshot.metrics),
    JSON.stringify(snapshot.pages)
  );
  return snapshot;
}

/** The site's snapshots, newest first. */
export async function snapshots(db: Database, siteId: number, limit = 10): Promise<Snapshot[]> {
  const rows = await db.query<any[]>(
    'select taken_at, metrics, pages from crawl_snapshot where site_id = ? order by taken_at desc, id desc limit ?',
    siteId,
    limit
  );
  return rows.map((row) => ({ takenAt: row.taken_at, metrics: row.metrics, pages: row.pages }));
}

const percent = (share: number) => `${Math.round(share * 100)}%`;
const share = (n: number, of: number) => (of ? n / of : 0);

/**
 * What got worse from `before` to `after`, one sentence each; empty when nothing
 * did. The failing share of pages is judged by the core; each metric by the
 * rule its domain declares.
 */
export function regressions(
  before: Snapshot,
  after: Snapshot,
  rules: Record<string, { label: string; regression?: RegressionRule }> = domain().metricRules
): string[] {
  const found: string[] = [];
  for (const [name, { label, regression }] of Object.entries(rules)) {
    if (!regression) continue;
    const was = before.metrics[name] ?? 0;
    const now = after.metrics[name] ?? 0;
    if (regression.kind === 'drop') {
      if (was >= MIN_COUNT && now < was * (1 - regression.percent / 100)) {
        found.push(`${label} fell from ${was} to ${now} (-${percent(1 - now / was)}) since the last complete crawl`);
      }
    } else {
      const ofBefore = before.metrics[regression.of] ?? 0;
      const ofAfter = after.metrics[regression.of] ?? 0;
      if (ofBefore >= MIN_COUNT && ofAfter >= MIN_COUNT) {
        const shareBefore = share(was, ofBefore);
        const shareAfter = share(now, ofAfter);
        if (shareBefore - shareAfter >= regression.points / 100) {
          found.push(`${label} fell from ${percent(shareBefore)} to ${percent(shareAfter)}`);
        }
      }
    }
  }
  const pagesBefore = before.pages.done + before.pages.failed;
  const pagesAfter = after.pages.done + after.pages.failed;
  const failedBefore = share(before.pages.failed, pagesBefore);
  const failedAfter = share(after.pages.failed, pagesAfter);
  if (pagesAfter >= MIN_COUNT && after.pages.failed >= MIN_COUNT && failedAfter - failedBefore >= FAILED_SHARE_RISE) {
    found.push(
      `failing pages rose from ${percent(failedBefore)} (${before.pages.failed} of ${pagesBefore}) ` +
        `to ${percent(failedAfter)} (${after.pages.failed} of ${pagesAfter})`
    );
  }
  return found;
}
