// A crawler process's row in crawler_run. A run is live while its status is
// running and it beats: whoever records how it ends beats for it - the
// supervisor for the children it spawned, a crawl started from a terminal for
// itself. A run that stopped beating is over (its process, or the server that
// owned it, died): reapRuns records it interrupted. A run's busy urls are
// released the moment it is over, however it ended.

import { hostname } from 'os';

import { Database } from 'sqlex';

type Queryable = Pick<Database, 'query'>;

export type RunStatus = 'running' | 'stopped' | 'blocked' | 'crashed' | 'interrupted';

export const HEARTBEAT_MS = 15_000;

/** SQL: run `r` is live - four missed beats and it is not. */
export const live = (r = 'r') =>
  `(${r}.status = 'running' and ${r}.heartbeat_at is not null and ${r}.heartbeat_at > now() - interval '60 seconds')`;

/** A second crawl of a site that has one running. */
export class CrawlRunning extends Error {}

/**
 * Records a run on this host, after reaping the dead ones: a crawl that died
 * must not hold its site. Throws CrawlRunning when the site has a live crawl.
 */
export async function openRun(
  db: Queryable,
  run: { siteId: number; kind: 'crawl' | 'oneshot'; pid?: number },
): Promise<number> {
  await reapRuns(db);
  try {
    const [row] = await db.query<{ id: number }[]>(
      "insert into crawler_run (site_id, kind, pid, host, heartbeat_at, status) values (?, ?, ?, ?, now(), 'running') returning id",
      run.siteId,
      run.kind,
      run.pid ?? null,
      hostname(),
    );
    return Number(row.id);
  } catch (err: any) {
    if (err?.code !== '23505') throw err;
    const [other] = await db.query<{ id: number; pid: number | null; host: string | null }[]>(
      "select id, pid, host from crawler_run where site_id = ? and kind = 'crawl' and status = 'running'",
      run.siteId,
    );
    throw new CrawlRunning(
      `a crawl of this site is already running: run #${other?.id}, pid ${other?.pid} on ${other?.host}`,
    );
  }
}

/** Beats for these runs; returns those still running - a run reaped meanwhile is not. */
export async function beat(db: Queryable, runIds: number[]): Promise<number[]> {
  if (runIds.length === 0) return [];
  const rows = await db.query<{ id: number }[]>(
    "update crawler_run set heartbeat_at = now() where id in (?) and status = 'running' returning id",
    runIds,
  );
  return rows.map((row) => Number(row.id));
}

/** Beats for a run of this process until stopped; `lost` when it was reaped, as if dead. */
export function keepBeating(db: Queryable, runId: number, lost: () => void): { stop(): void } {
  const timer = setInterval(() => {
    beat(db, [runId])
      .then((running) => running.length === 0 && lost())
      .catch((err) => console.error('heartbeat:', err));
  }, HEARTBEAT_MS);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}

/** Records how a run ended, unless it was already recorded over, and releases its busy urls. */
export async function endRun(
  db: Queryable,
  runId: number,
  status: Exclude<RunStatus, 'running'>,
  exitCode: number | null,
): Promise<void> {
  await db.query(
    `with ended as (
       update crawler_run set status = ?, exit_code = ?, stopped_at = now() where id = ? and status = 'running')
     update url set status = 0, claimed_run_id = null where claimed_run_id = ? and status = 1`,
    status,
    exitCode,
    runId,
    runId,
  );
}

/** Records the runs that stopped beating as interrupted and releases their busy urls; returns their ids. */
export async function reapRuns(db: Queryable): Promise<number[]> {
  const rows = await db.query<{ id: number }[]>(
    `with dead as (
       update crawler_run r set status = 'interrupted', stopped_at = now()
        where r.status = 'running' and not ${live('r')}
       returning r.id),
     released as (
       update url set status = 0, claimed_run_id = null where status = 1 and claimed_run_id in (select id from dead))
     select id from dead`,
  );
  return rows.map((row) => Number(row.id));
}
