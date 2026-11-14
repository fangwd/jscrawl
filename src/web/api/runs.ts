// Read queries over crawler_run for the web API: the runs of every site, one
// run with what it fetched and holds, and the fetches it made.

import { hostname } from 'os';

import { Database } from 'sqlex';

import { live, RunStatus } from '../../core/runs';
import { num, Page, pageParams } from './read';

type Queryable = Pick<Database, 'query'>;

const STATUSES: RunStatus[] = ['running', 'stopped', 'blocked', 'crashed', 'interrupted'];

export interface RunFilter {
  siteId?: number;
  status?: string;
  kind?: string;
  page?: number;
  pageSize?: number;
}

/** A fetch that got no page: no response, or an HTTP error. */
const FAILED = '(f.error is not null or f.http_status >= 400)';

const RUN_COLUMNS = `r.id, r.site_id, s.name as site_name, r.kind, r.pid, r.host, r.status, r.started_at, r.stopped_at,
       r.heartbeat_at, r.exit_code, ${live('r')} as live,
       (select count(*) from url_fetch f where f.run_id = r.id) as fetches,
       (select count(*) from url_fetch f where f.run_id = r.id and ${FAILED}) as failed`;

function runRow(r: any) {
  // not recorded as over yet, but over since its last beat: the next reap records it
  const dead = r.status === 'running' && r.live !== true;
  return {
    id: Number(r.id),
    siteId: Number(r.site_id),
    siteName: r.site_name as string,
    kind: r.kind as string,
    status: (dead ? 'interrupted' : r.status) as RunStatus,
    live: r.live === true,
    pid: r.pid as number | null,
    host: r.host as string | null,
    /** It runs, or ran, on the server's host. */
    local: r.host === hostname(),
    startedAt: r.started_at,
    stoppedAt: dead ? r.heartbeat_at : (r.stopped_at ?? null),
    exitCode: r.exit_code as number | null,
    fetches: Number(r.fetches),
    failed: Number(r.failed),
  };
}

export type RunRow = ReturnType<typeof runRow>;

/** Every site's runs, the latest first. */
export async function listRuns(db: Queryable, filter: RunFilter): Promise<Page<RunRow>> {
  const where: string[] = [];
  const args: unknown[] = [];
  if (filter.siteId !== undefined) {
    where.push('r.site_id = ?');
    args.push(filter.siteId);
  }
  if (filter.kind) {
    where.push('r.kind = ?');
    args.push(filter.kind);
  }
  if (filter.status && STATUSES.includes(filter.status as RunStatus)) {
    // as runRow reports it: a run that stopped beating is interrupted, not running
    if (filter.status === 'running') where.push(live('r'));
    else if (filter.status === 'interrupted')
      where.push(`(r.status = 'interrupted' or (r.status = 'running' and not ${live('r')}))`);
    else {
      where.push('r.status = ?');
      args.push(filter.status);
    }
  }
  const clause = where.length ? `where ${where.join(' and ')}` : '';
  const { size, p, offset } = pageParams(filter.page, filter.pageSize);
  const [count] = await db.query<any[]>(
    `select count(*) as n from crawler_run r ${clause}`,
    ...args,
  );
  const rows = await db.query<any[]>(
    `select ${RUN_COLUMNS}
       from crawler_run r join site s on s.id = r.site_id
       ${clause}
      order by r.id desc limit ? offset ?`,
    ...args,
    size,
    offset,
  );
  return {
    total: Number(count.n),
    page: p,
    pageSize: size,
    rows: rows.map(runRow),
  };
}

/** A run, what its fetches came to, and the urls it holds while it goes on; null when there is no such run. */
export async function runDetail(db: Queryable, id: number) {
  const [row] = await db.query<any[]>(
    `select ${RUN_COLUMNS}, r.log_path from crawler_run r join site s on s.id = r.site_id where r.id = ?`,
    id,
  );
  if (!row) return null;
  const [[fetched], holding] = await Promise.all([
    db.query<any[]>(
      'select avg(f.fetch_duration) as duration, sum(f.content_length) as bytes from url_fetch f where f.run_id = ?',
      id,
    ),
    db.query<any[]>(
      'select u.id, u.url, u.type, u.claimed_at from url u where u.claimed_run_id = ? and u.status = 1 order by u.claimed_at, u.id limit 50',
      id,
    ),
  ]);
  return {
    ...runRow(row),
    heartbeatAt: row.heartbeat_at ?? null,
    logPath: row.log_path as string | null,
    /** Milliseconds a fetch took on average; null when it made none. */
    fetchDuration: num(fetched.duration),
    bytes: Number(fetched.bytes ?? 0),
    holding: holding.map((u) => ({
      id: Number(u.id),
      url: u.url as string,
      type: u.type as string,
      claimedAt: u.claimed_at,
    })),
  };
}

/** The fetches a run made, the latest first; `failed` keeps those that got no page. */
export async function runFetches(
  db: Queryable,
  id: number,
  filter: { failed?: boolean; page?: number; pageSize?: number },
): Promise<Page<any>> {
  const clause = `where f.run_id = ?${filter.failed ? ` and ${FAILED}` : ''}`;
  const { size, p, offset } = pageParams(filter.page, filter.pageSize);
  const [count] = await db.query<any[]>(`select count(*) as n from url_fetch f ${clause}`, id);
  const rows = await db.query<any[]>(
    `select f.id, f.url_id, u.url, u.type, f.fetch_time, f.fetch_duration, f.http_status, f.error, f.content_length
       from url_fetch f join url u on u.id = f.url_id
       ${clause}
      order by f.fetch_time desc, f.id desc limit ? offset ?`,
    id,
    size,
    offset,
  );
  return {
    total: Number(count.n),
    page: p,
    pageSize: size,
    rows: rows.map((f) => ({
      id: Number(f.id),
      urlId: Number(f.url_id),
      url: f.url as string,
      type: f.type as string,
      fetchTime: f.fetch_time,
      /** Milliseconds. */
      fetchDuration: num(f.fetch_duration),
      httpStatus: f.http_status as number | null,
      error: f.error as string | null,
      contentLength: Number(f.content_length),
    })),
  };
}
