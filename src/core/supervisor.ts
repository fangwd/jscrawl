// Owns crawler child processes: run bookkeeping in crawler_run, logs under
// <logDir>, beats for its children's runs and reaps the runs that stopped
// beating (see ./runs.ts). Which crawls are running is the database's word, so
// a crawl started from a terminal counts too: at most one per site, wherever it
// runs, and one on this host can be stopped. Driven by the web API and the
// agent's crawl tools; the children are plain `jscrawl --crawl` CLI processes
// that stop gracefully on SIGTERM (see entries/cli.ts).

import { ChildProcess, spawn } from 'child_process';
import { createWriteStream } from 'fs';
import { mkdir, open, type FileHandle } from 'fs/promises';
import { hostname } from 'os';
import { join } from 'path';

import { Database } from 'sqlex';

import { BLOCKED_EXIT_CODE } from './models';
import { reapProxies } from './proxy';
import { beat, CrawlRunning, endRun, HEARTBEAT_MS, live, openRun, reapRuns } from './runs';
import { sha1 } from './utils';

const STOP_GRACE_MS = 10_000;

export class SupervisorError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface SupervisorOptions {
  cwd: string;
  logDir: string;
  /** Child argv; injectable in tests. Defaults run the CLI through ts-node. */
  crawlCommand?: (siteName: string) => string[];
  oneshotCommand?: (url: string) => string[];
}

export interface SiteCrawlStatus {
  siteId: number;
  siteName: string;
  /** Its last crawl run's process is alive, wherever it was started. */
  running: boolean;
  pid: number | null;
  runId: number | null;
  /** Of the site's last crawl run; a one-shot re-scrape does not count. A run that stopped beating is interrupted. */
  lastStatus: string | null;
  startedAt: Date | null;
  stoppedAt: Date | null;
  /** Minutes between scheduled re-crawls; null when only by hand. */
  refreshMinutes: number | null;
  /** Verdicts awaiting a person's review; while there are any, no crawl of the site starts. */
  hold: number;
}

/** Site `s`'s verdicts awaiting a person's review: its triaged issues of their own, not copies. */
const HOLD = `(select count(*) from issue i join url iu on iu.id = i.url_id
  where iu.site_id = s.id and i.status = 'triaged' and i.same_as is null)`;
const ON_HOLD = `${HOLD} > 0`;
/** Site `s` has a live crawl. */
const CRAWLING = `exists (select 1 from crawler_run r where r.site_id = s.id and r.kind = 'crawl' and ${live('r')})`;

/** A live run, crawl or one-shot, for an operator deciding what to stop. */
export interface LiveRun {
  id: number;
  siteId: number;
  siteName: string;
  kind: string;
  pid: number | null;
  host: string | null;
  startedAt: Date;
  /** It runs on this host, where its process can be signalled. */
  local: boolean;
}

async function readBytes(
  handle: FileHandle,
  from: number,
  to: number,
): Promise<{ text: string; start: number }> {
  const buffer = Buffer.alloc(Math.max(0, to - from));
  await handle.read(buffer, 0, buffer.length, from);
  return { text: buffer.toString('utf8'), start: from };
}

/** The bytes `from`..`to` of the file, less the partial first line when `from` is inside one. */
async function readLines(
  handle: FileHandle,
  from: number,
  to: number,
): Promise<{ text: string; start: number }> {
  const { text } = await readBytes(handle, from, to);
  if (from === 0) return { text, start: 0 };
  const partial = text.slice(0, text.indexOf('\n') + 1);
  return {
    text: text.slice(partial.length),
    start: from + Buffer.byteLength(partial),
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class Supervisor {
  /** run id -> running child, crawl or one-shot */
  private children = new Map<number, ChildProcess>();
  /** Children asked to stop: however they exit, they stopped rather than crashed. */
  private stopping = new Set<ChildProcess>();
  /** Settles once a child's exit is written to crawler_run. */
  private recorded = new Map<ChildProcess, Promise<void>>();
  private beating?: NodeJS.Timeout;

  constructor(
    private db: Database,
    private options: SupervisorOptions,
  ) {}

  get logDir(): string {
    return this.options.logDir;
  }

  /**
   * Reaps the runs a previous server left running - its children stopped
   * beating with it - and starts beating for this one's children.
   */
  async init(): Promise<void> {
    await mkdir(this.options.logDir, { recursive: true });
    await this.reap();
    await this.reapProxies();
    this.beating = setInterval(() => {
      beat(this.db, [...this.children.keys()])
        .then(() => this.reap())
        .catch((err) => console.error('crawl run heartbeat:', err));
    }, HEARTBEAT_MS);
    this.beating.unref();
  }

  /** Records the runs that stopped beating as interrupted, releasing their urls and proxies; returns their ids. */
  async reap(): Promise<number[]> {
    const dead = await reapRuns(this.db);
    if (dead.length > 0) {
      console.warn(`Crawl runs ${dead.join(', ')} stopped beating: recorded as interrupted`);
      await this.reapProxies();
    }
    return dead;
  }

  /** Removes the proxies of runs that are over: a crawl killed before it could remove its own. */
  private async reapProxies(): Promise<void> {
    try {
      const running = await this.db.query<{ id: number }[]>(
        "select id from crawler_run where status = 'running'",
      );
      await reapProxies({
        runs: new Set(running.map((row) => Number(row.id))),
      });
    } catch (err) {
      console.error('reaping proxies:', err);
    }
  }

  async status(): Promise<SiteCrawlStatus[]> {
    const rows = await this.db.query<any[]>(
      `select s.id as site_id, s.name as site_name, r.id as run_id, r.pid, r.status, r.started_at, r.stopped_at,
              r.heartbeat_at, ${live('r')} as live, c.refresh_minutes, ${HOLD} as hold
         from site s
         left join crawler c on c.id = s.crawler_id
         left join crawler_run r on r.id = (
           select r2.id from crawler_run r2 where r2.site_id = s.id and r2.kind = 'crawl'
            order by r2.started_at desc, r2.id desc limit 1)
        order by s.name`,
    );
    return rows.map((r) => {
      const running = r.live === true;
      // not recorded as over yet, but over since its last beat: the next reap records it
      const dead = r.status === 'running' && !running;
      return {
        siteId: Number(r.site_id),
        siteName: r.site_name,
        running,
        pid: running ? r.pid : null,
        runId: r.run_id != null ? Number(r.run_id) : null,
        lastStatus: dead ? 'interrupted' : (r.status ?? null),
        startedAt: r.started_at ?? null,
        stoppedAt: dead ? r.heartbeat_at : (r.stopped_at ?? null),
        refreshMinutes: r.refresh_minutes ?? null,
        hold: Number(r.hold),
      };
    });
  }

  /** Every live run, oldest first. */
  async running(): Promise<LiveRun[]> {
    const rows = await this.db.query<any[]>(
      `select r.id, r.site_id, s.name as site_name, r.kind, r.pid, r.host, r.started_at
         from crawler_run r join site s on s.id = r.site_id
        where ${live('r')}
        order by r.started_at, r.id`,
    );
    const here = hostname();
    return rows.map((r) => ({
      id: Number(r.id),
      siteId: Number(r.site_id),
      siteName: r.site_name,
      kind: r.kind,
      pid: r.pid,
      host: r.host,
      startedAt: r.started_at,
      local: r.host === here,
    }));
  }

  async runs(siteId: number, limit = 10) {
    const rows = await this.db.query<any[]>(
      `select id, kind, pid, status, started_at, stopped_at, exit_code, log_path
         from crawler_run where site_id = ? order by id desc limit ?`,
      siteId,
      limit,
    );
    return rows.map((r) => ({
      id: Number(r.id),
      kind: r.kind,
      pid: r.pid,
      status: r.status,
      startedAt: r.started_at,
      stoppedAt: r.stopped_at,
      exitCode: r.exit_code,
      logPath: r.log_path,
    }));
  }

  /** Site by numeric id or exact name; shared by the tools and the web API. */
  async resolveSite(raw: string | number): Promise<{ id: number; name: string }> {
    const [row] = /^\d+$/.test(String(raw))
      ? await this.db.query<{ id: number; name: string }[]>(
          'select id, name from site where id = ?',
          Number(raw),
        )
      : await this.db.query<{ id: number; name: string }[]>(
          'select id, name from site where name = ?',
          String(raw),
        );
    if (!row) throw new SupervisorError(404, `No site ${raw}`);
    return { id: Number(row.id), name: row.name };
  }

  /** Re-scrape by url string or numeric url id. */
  async rescrapeUrl(target: string | number, mode: 'queue' | 'oneshot') {
    const [url] = await this.db.query<{ id: number }[]>(
      /^\d+$/.test(String(target))
        ? 'select id from url where id = ?'
        : 'select id from url where hash = ?',
      /^\d+$/.test(String(target)) ? Number(target) : sha1(String(target)),
    );
    if (!url) throw new SupervisorError(404, `No url ${target}`);
    return this.rescrape(Number(url.id), mode);
  }

  /**
   * The tail of a run's log: the latest run of the site when runId is omitted.
   * `start` is where the text begins in the file, for reading what came before.
   */
  async logTail(siteId: number, runId: number | undefined, bytes = 64 * 1024) {
    const run = runId !== undefined ? { id: runId } : (await this.runs(siteId, 1))[0];
    if (!run) throw new SupervisorError(404, 'No runs for this site');
    const [row] = await this.db.query<{ log_path: string | null; status: string }[]>(
      'select log_path, status from crawler_run where id = ?',
      run.id,
    );
    if (!row?.log_path) throw new SupervisorError(404, `No log for run ${run.id}`);
    const handle = await open(row.log_path, 'r');
    try {
      const size = (await handle.stat()).size;
      const from = Math.max(0, size - bytes);
      const { text, start } = await readLines(handle, from, size);
      return {
        runId: run.id,
        text,
        start,
        offset: size,
        running: row.status === 'running',
      };
    } finally {
      await handle.close();
    }
  }

  async start(siteId: number): Promise<number> {
    const site = await this.site(siteId);
    await this.ensureNotHeld(site);
    const argv = this.options.crawlCommand?.(site.name) ?? [
      process.execPath,
      '-r',
      'ts-node/register',
      'src/cli.ts',
      '--crawl',
      site.name,
    ];
    return this.spawn(site, 'crawl', argv);
  }

  async stop(siteId: number): Promise<void> {
    const site = await this.site(siteId);
    const runId = await this.liveCrawl(site.id);
    if (runId === null) throw new SupervisorError(409, `no crawl is running for ${site.name}`);
    await this.stopRun(runId);
  }

  async restart(siteId: number): Promise<number> {
    await this.ensureNotHeld(await this.site(siteId));
    const runId = await this.liveCrawl(siteId);
    if (runId !== null) await this.stopRun(runId);
    return this.start(siteId);
  }

  /**
   * Stops a live run gracefully, and waits until it is recorded over: a child of
   * this server as ever; another process on this host - a crawl started from a
   * terminal - by SIGTERM, as on Ctrl+C, then SIGKILL after the grace period. A
   * run on another host is stopped there.
   */
  async stopRun(runId: number): Promise<void> {
    const child = this.children.get(runId);
    if (child) return this.kill(child);
    const [run] = await this.db.query<{ pid: number | null; host: string | null }[]>(
      `select r.pid, r.host from crawler_run r where r.id = ? and ${live('r')}`,
      runId,
    );
    if (!run) throw new SupervisorError(409, `run ${runId} is not running`);
    if (run.pid == null || run.host !== hostname()) {
      throw new SupervisorError(
        409,
        `run ${runId} runs on ${run.host ?? 'another host'}: stop it there`,
      );
    }
    const over = async () =>
      (
        await this.db.query<{ status: string }[]>(
          'select status from crawler_run where id = ?',
          runId,
        )
      )[0]?.status !== 'running';
    signal(run.pid, 'SIGTERM');
    const until = Date.now() + STOP_GRACE_MS;
    while (Date.now() < until) {
      if (await over()) return;
      await sleep(200);
    }
    signal(run.pid, 'SIGKILL');
    await endRun(this.db, runId, 'stopped', null);
  }

  /** queue: reset the url to idle for a running crawl; oneshot: scrape it in a short-lived child. */
  async rescrape(
    urlId: number,
    mode: 'queue' | 'oneshot',
  ): Promise<{ queued?: boolean; runId?: number }> {
    const [url] = await this.db.query<any[]>(
      `select u.id, u.url, u.status, s.id as site_id, s.name as site_name
         from url u join site s on s.id = u.site_id where u.id = ?`,
      urlId,
    );
    if (!url) throw new SupervisorError(404, `No url ${urlId}`);
    if (mode === 'queue') {
      await this.db.query('update url set status = 0 where id = ? and status <> 1', url.id);
      return { queued: true };
    }
    const siteId = Number(url.site_id);
    if ((await this.liveCrawl(siteId)) !== null) {
      throw new SupervisorError(
        409,
        `a crawl for ${url.site_name} is running; queue the re-scrape instead`,
      );
    }
    const argv = this.options.oneshotCommand?.(url.url) ?? [
      process.execPath,
      '-r',
      'ts-node/register',
      'src/cli.ts',
      '--scrape-url',
      url.url,
    ];
    return {
      runId: await this.spawn({ id: siteId, name: url.site_name }, 'oneshot', argv),
    };
  }

  /**
   * Idles the done, failed and disallowed urls of one site, or of every site
   * (null), so the next crawl fetches them again - or `onlyFailed`, just the failed.
   * A disallowed url is checked against the path rules and the site's robots.txt
   * again before it is fetched, so rules relaxed since are picked up. Returns how
   * many, and the sites they belong to.
   */
  async resetUrls(
    siteId: number | null,
    options: { onlyFailed?: boolean; dry?: boolean },
  ): Promise<{ affected: number; siteIds: number[] }> {
    if (siteId !== null) await this.site(siteId);
    const where = `${options.onlyFailed ? 'status < 0' : '(status in (2, 3) or status < 0)'}${siteId === null ? '' : ' and site_id = ?'}`;
    const args = siteId === null ? [] : [siteId];
    if (options.dry) {
      const rows = await this.db.query<{ site_id: number; n: string }[]>(
        `select site_id, count(*) as n from url where ${where} group by site_id`,
        ...args,
      );
      return {
        affected: rows.reduce((n, row) => n + Number(row.n), 0),
        siteIds: rows.map((row) => Number(row.site_id)),
      };
    }
    const rows = await this.db.query<{ site_id: number }[]>(
      `update url set status = 0 where ${where} returning site_id`,
      ...args,
    );
    return {
      affected: rows.length,
      siteIds: [...new Set(rows.map((row) => Number(row.site_id)))],
    };
  }

  /** Sites whose last crawl ended - stopped, blocked, crashed or interrupted: the ones a resume restarts. */
  async stoppedSites(): Promise<number[]> {
    return (await this.status())
      .filter((site) => !site.running && site.lastStatus !== null && site.lastStatus !== 'running')
      .map((site) => site.siteId);
  }

  /**
   * Those of these sites with idle urls a crawl fetches - images it does not -
   * not on hold and no crawl running, and how many urls each has idle: what startIdle starts.
   */
  async idleSites(siteIds: number[]): Promise<{ siteId: number; urls: number }[]> {
    if (siteIds.length === 0) return [];
    const wanted = new Set(siteIds);
    const idle = await this.db.query<{ site_id: number; n: string }[]>(
      `select u.site_id, count(*) as n
         from url u join site s on s.id = u.site_id
        where u.status = 0 and u.type <> 'image' and not ${ON_HOLD} and not ${CRAWLING}
        group by u.site_id, s.name
        order by s.name`,
    );
    return idle
      .map((row) => ({ siteId: Number(row.site_id), urls: Number(row.n) }))
      .filter((site) => wanted.has(site.siteId));
  }

  /**
   * Re-crawls every site whose refresh interval has passed since its last crawl
   * started: its urls are reset as by a recrawl and its crawl started. A site
   * never crawled is not scheduled - its first crawl is someone's decision - one
   * still crawling waits for its run to end, and one on hold waits for its review.
   */
  async refreshDue(): Promise<{ siteId: number; runId: number }[]> {
    const due = await this.db.query<{ id: number }[]>(
      `select s.id from site s join crawler c on c.id = s.crawler_id
        where c.refresh_minutes is not null
          and not ${ON_HOLD}
          and not ${CRAWLING}
          and exists (select 1 from crawler_run r where r.site_id = s.id and r.kind = 'crawl')
          and not exists (
            select 1 from crawler_run r where r.site_id = s.id and r.kind = 'crawl'
               and r.started_at > now() - c.refresh_minutes * interval '1 minute')
        order by s.name`,
    );
    const started: { siteId: number; runId: number }[] = [];
    for (const { id } of due) {
      const siteId = Number(id);
      await this.resetUrls(siteId, {});
      started.push({ siteId, runId: await this.start(siteId) });
    }
    return started;
  }

  /** Starts a crawl for each of these sites that has idle urls and no crawl running. */
  async startIdle(siteIds: number[]): Promise<{ siteId: number; runId: number }[]> {
    const started: { siteId: number; runId: number }[] = [];
    for (const { siteId } of await this.idleSites(siteIds)) {
      started.push({ siteId, runId: await this.start(siteId) });
    }
    return started;
  }

  /**
   * The run's log from `offset` on; offset 0 with a shrunken file restarts it.
   * With `limit`, at most that many bytes from `offset`, starting on a whole
   * line: `start` says where the text begins and `offset` where it ends, so a
   * reader can page backwards through the file.
   */
  async log(
    runId: number,
    offset = 0,
    limit?: number,
  ): Promise<{
    runId: number;
    text: string;
    start: number;
    offset: number;
    running: boolean;
  }> {
    const [row] = await this.db.query<{ log_path: string | null; status: string }[]>(
      'select log_path, status from crawler_run where id = ?',
      runId,
    );
    if (!row?.log_path) throw new SupervisorError(404, `No log for run ${runId}`);
    const handle = await open(row.log_path, 'r');
    try {
      const size = (await handle.stat()).size;
      const from = offset > size ? 0 : offset;
      const to = limit === undefined ? size : Math.min(size, from + limit);
      const { text, start } =
        limit === undefined ? await readBytes(handle, from, to) : await readLines(handle, from, to);
      return {
        runId,
        text,
        start,
        offset: to,
        running: row.status === 'running',
      };
    } finally {
      await handle.close();
    }
  }

  /** Stops every child gracefully and the heartbeat; called when the server shuts down. */
  async shutdown(): Promise<void> {
    clearInterval(this.beating);
    await Promise.all([...this.children.values()].map((child) => this.kill(child)));
  }

  private async site(siteId: number): Promise<{ id: number; name: string }> {
    return this.resolveSite(siteId);
  }

  /** The site's live crawl run, wherever it was started; null when none. */
  async liveCrawl(siteId: number): Promise<number | null> {
    const [row] = await this.db.query<{ id: number }[]>(
      `select r.id from crawler_run r where r.site_id = ? and r.kind = 'crawl' and ${live('r')}`,
      siteId,
    );
    return row ? Number(row.id) : null;
  }

  /** A site with verdicts awaiting review is on hold: resolving or ignoring them lifts it. */
  private async ensureNotHeld(site: { id: number; name: string }): Promise<void> {
    const [row] = await this.db.query<{ hold: string }[]>(
      `select ${HOLD} as hold from site s where s.id = ?`,
      site.id,
    );
    const hold = Number(row.hold);
    if (hold > 0) {
      throw new SupervisorError(
        409,
        `${site.name} is on hold: ${hold} verdict${hold === 1 ? '' : 's'} awaiting review; resolve or ignore them to crawl again`,
      );
    }
  }

  private async spawn(
    site: { id: number; name: string },
    kind: 'crawl' | 'oneshot',
    argv: string[],
  ): Promise<number> {
    let runId: number;
    try {
      runId = await openRun(this.db, { siteId: site.id, kind });
    } catch (err) {
      if (err instanceof CrawlRunning)
        throw new SupervisorError(409, `${site.name}: ${err.message}`);
      throw err;
    }
    const logPath = join(this.options.logDir, `${kind}-${runId}.log`);
    const child = spawn(argv[0], argv.slice(1), {
      cwd: this.options.cwd,
      // its claims and proxies name the run, so they are released once it is over
      env: { ...process.env, JSCRAWL_RUN_ID: String(runId) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const log = createWriteStream(logPath, { flags: 'a' });
    child.stdout?.pipe(log);
    child.stderr?.pipe(log);
    await this.db.query(
      'update crawler_run set pid = ?, log_path = ? where id = ?',
      child.pid ?? null,
      logPath,
      runId,
    );
    this.children.set(runId, child);
    let recorded!: () => void;
    this.recorded.set(child, new Promise((resolve) => (recorded = resolve)));
    child.on('exit', (code, signal) => {
      this.children.delete(runId);
      log.end();
      // a stop signal from the terminal (Ctrl+C reaches the whole process group) or from us is not a crash
      const stopped =
        code === 0 || signal === 'SIGINT' || signal === 'SIGTERM' || this.stopping.has(child);
      this.stopping.delete(child);
      endRun(
        this.db,
        runId,
        stopped ? 'stopped' : code === BLOCKED_EXIT_CODE ? 'blocked' : 'crashed',
        code,
      )
        .catch((err) => console.error('crawler_run update:', err))
        .then(() => this.reapProxies())
        .finally(() => {
          this.recorded.delete(child);
          recorded();
        });
    });
    child.on('error', (err) => log.write(`spawn error: ${err}\n`));
    return runId;
  }

  /** Stops a child (SIGKILL after the grace period) and waits until its run is recorded as stopped. */
  private async kill(child: ChildProcess): Promise<void> {
    const recorded = this.recorded.get(child);
    if (child.exitCode === null && child.signalCode === null) {
      this.stopping.add(child);
      await new Promise<void>((done) => {
        const timer = setTimeout(() => child.kill('SIGKILL'), STOP_GRACE_MS);
        child.once('exit', () => {
          clearTimeout(timer);
          done();
        });
        child.kill('SIGTERM');
      });
    }
    await recorded;
  }
}

/** Signals a process that may be gone already. */
function signal(pid: number, name: NodeJS.Signals): void {
  try {
    process.kill(pid, name);
  } catch {
    // gone
  }
}
