// Write endpoints for the web console: human overrides on issues and edits of a
// site's crawler. Verdicts stay with the agents (resolveIssue), issues with the
// crawler (recordIssue).

import { spawn } from 'child_process';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import { Database } from 'sqlex';

import { sameProblem } from '../../core/issues';
import { Config } from '../../core/models';
import { crawlerSource, crawlerFile } from './read';

export interface ActionResult {
  status: number;
  body: any;
}

const HUMAN_STATUSES = ['open', 'resolved', 'ignored'];

/**
 * Human status override; a note is appended to the resolution for the record.
 * The issues that took this one's verdict and still share its status follow it,
 * except a reopened copy whose page already has another unsettled issue.
 */
export async function patchIssue(
  db: Database,
  id: number,
  changes: { status?: string; note?: string },
): Promise<ActionResult> {
  const { status, note } = changes;
  if (typeof status !== 'string' || !HUMAN_STATUSES.includes(status)) {
    return {
      status: 400,
      body: { error: `status must be one of: ${HUMAN_STATUSES.join(', ')}` },
    };
  }
  if (note !== undefined && typeof note !== 'string') {
    return { status: 400, body: { error: 'note must be a string' } };
  }
  const [existing] = await db.query<{ id: number; status: string }[]>(
    'select id, status from issue where id = ?',
    id,
  );
  if (!existing) return { status: 404, body: { error: `No issue ${id}` } };
  let copies = 0;
  if (existing.status !== status) {
    const resolvedAt = status === 'open' ? null : new Date();
    await db.transaction(async (connection) => {
      await connection.query(
        'update issue set status = ?, resolved_at = ? where id = ?',
        status,
        resolvedAt,
        id,
      );
      const rows = (await connection.query(
        `update issue c set status = ?, resolved_at = ?
           from issue i, url iu, url cu
          where i.id = ? and c.same_as = i.id and c.status = ?
            and iu.id = i.url_id and cu.id = c.url_id
            and ${sameProblem('c', 'cu', 'i', 'iu')}
            and (? <> 'open' or not exists (
              select 1 from issue o
               where o.url_id = c.url_id and o.kind = c.kind and o.id <> c.id and o.status in ('open', 'triaged')))
          returning c.id`,
        status,
        resolvedAt,
        id,
        existing.status,
        status,
      )) as unknown[];
      copies = rows.length;
    });
  }
  if (note) {
    await db.query(
      `update issue set resolution = coalesce(resolution || E'\n\n', '') || ? where id = ?`,
      `[operator note] ${note}`,
      id,
    );
  }
  return {
    status: 200,
    body: { id, status, changed: existing.status !== status, copies },
  };
}

/** The most fetch loops a site's crawl may run. */
export const MAX_THREAD_COUNT = 8;

/** The operator's settings on the site row; only the thread count so far, the rest is the crawler module's. */
export async function patchSite(
  db: Database,
  id: number,
  changes: { threadCount?: unknown },
): Promise<ActionResult> {
  const { threadCount } = changes;
  if (
    typeof threadCount !== 'number' ||
    !Number.isInteger(threadCount) ||
    threadCount < 1 ||
    threadCount > MAX_THREAD_COUNT
  ) {
    return {
      status: 400,
      body: {
        error: `threadCount must be a whole number from 1 to ${MAX_THREAD_COUNT}`,
      },
    };
  }
  const rows = (await db.query(
    'update site set thread_count = ? where id = ? returning id',
    threadCount,
    id,
  )) as unknown[];
  if (rows.length === 0) return { status: 404, body: { error: `No site ${id}` } };
  return { status: 200, body: { id, threadCount } };
}

/**
 * Saves an edit of the site's crawler made on top of the version `hash` names.
 * When the file changed meanwhile - the agent edited it, or a sync brought a
 * merged one - the save is refused with the file as it is now.
 */
export async function saveCrawler(
  config: Config,
  name: string,
  edit: { code?: unknown; hash?: unknown },
  cwd?: string,
): Promise<ActionResult> {
  if (typeof edit.code !== 'string' || typeof edit.hash !== 'string') {
    return { status: 400, body: { error: 'code and hash are required' } };
  }
  const current = await crawlerSource(config, name, cwd);
  if (current.hash !== edit.hash) {
    return {
      status: 409,
      body: {
        error: `${current.file} changed since it was opened`,
        ...current,
      },
    };
  }
  await writeFile(crawlerFile(config, name), edit.code);
  return { status: 200, body: await crawlerSource(config, name, cwd) };
}

/** How long a live check may take: one page fetch (a browser under usePuppeteer) and its scrape. */
const LIVE_CHECK_TIMEOUT_MS = 180_000;

/**
 * Runs the live check (src/core/live-check.ts) in a child, as the deployment's
 * CLI, since it runs the site's crawler: `src/cli.ts --live-check <url id> <out>`.
 */
export async function liveCheckChild(urlId: number, cwd = process.cwd()): Promise<ActionResult> {
  const dir = await mkdtemp(join(tmpdir(), 'jscrawl-live-'));
  const out = join(dir, 'check.json');
  try {
    const { code, stderr } = await new Promise<{
      code: number | null;
      stderr: string;
    }>((done) => {
      const child = spawn(
        process.execPath,
        ['-r', 'ts-node/register', 'src/cli.ts', '--live-check', String(urlId), out],
        {
          cwd,
          stdio: ['ignore', 'ignore', 'pipe'],
          timeout: LIVE_CHECK_TIMEOUT_MS,
        },
      );
      let stderr = '';
      child.stderr.on('data', (chunk) => (stderr = (stderr + chunk).slice(-4000)));
      child.on('close', (code) => done({ code, stderr }));
      child.on('error', (err) => done({ code: null, stderr: String(err) }));
    });
    const result = await readFile(out, 'utf8').catch(() => null);
    if (result !== null) return { status: 200, body: JSON.parse(result) };
    return {
      status: 500,
      body: {
        error: `The live check ended without a result (exit ${code}): ${stderr.trim().split('\n').slice(-5).join('\n')}`,
      },
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
