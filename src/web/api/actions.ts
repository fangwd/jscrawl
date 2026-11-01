// Write endpoints for the web console: human overrides on issues and edits of a
// site's crawler. Verdicts stay with the agents (resolveIssue), issues with the
// crawler (recordIssue).

import { writeFile } from 'fs/promises';
import { Database } from 'sqlex';
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
  changes: { status?: string; note?: string }
): Promise<ActionResult> {
  const { status, note } = changes;
  if (typeof status !== 'string' || !HUMAN_STATUSES.includes(status)) {
    return { status: 400, body: { error: `status must be one of: ${HUMAN_STATUSES.join(', ')}` } };
  }
  if (note !== undefined && typeof note !== 'string') {
    return { status: 400, body: { error: 'note must be a string' } };
  }
  const [existing] = await db.query<{ id: number; status: string }[]>('select id, status from issue where id = ?', id);
  if (!existing) return { status: 404, body: { error: `No issue ${id}` } };
  let copies = 0;
  if (existing.status !== status) {
    const resolvedAt = status === 'open' ? null : new Date();
    await db.transaction(async (connection) => {
      await connection.query('update issue set status = ?, resolved_at = ? where id = ?', status, resolvedAt, id);
      const rows = (await connection.query(
        `update issue c set status = ?, resolved_at = ?
          where c.same_as = ? and c.status = ?
            and (? <> 'open' or not exists (
              select 1 from issue o
               where o.url_id = c.url_id and o.kind = c.kind and o.id <> c.id and o.status in ('open', 'triaged')))
          returning c.id`,
        status,
        resolvedAt,
        id,
        existing.status,
        status
      )) as unknown[];
      copies = rows.length;
    });
  }
  if (note) {
    await db.query(
      `update issue set resolution = coalesce(resolution || E'\n\n', '') || ? where id = ?`,
      `[operator note] ${note}`,
      id
    );
  }
  return { status: 200, body: { id, status, changed: existing.status !== status, copies } };
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
  cwd?: string
): Promise<ActionResult> {
  if (typeof edit.code !== 'string' || typeof edit.hash !== 'string') {
    return { status: 400, body: { error: 'code and hash are required' } };
  }
  const current = await crawlerSource(config, name, cwd);
  if (current.hash !== edit.hash) {
    return { status: 409, body: { error: `${current.file} changed since it was opened`, ...current } };
  }
  await writeFile(crawlerFile(config, name), edit.code);
  return { status: 200, body: await crawlerSource(config, name, cwd) };
}
