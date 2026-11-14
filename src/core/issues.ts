// The problems crawls find, recorded as `issue` rows for people and agents to
// triage. An agent works through the open problems (GET /api/problems) and
// records its verdict with jscrawl_resolveIssue; nothing here calls one.

import { relative } from 'path';

import { Database } from 'sqlex';

export type IssueKind = 'scrape_failed' | 'validation' | 'acceptance' | 'regression' | 'blocked';

/** One thing found wrong: `code` names the problem the same way on every page and crawl; `detail` describes this instance. */
export interface Finding {
  code: string;
  detail: string;
}

/** A scrape that threw, identified by the error's class and the first line of project code it passed through. */
export function thrownFinding(error: unknown): Finding {
  if (!(error instanceof Error)) return { code: 'thrown', detail: String(error) };
  const frame = (error.stack ?? '')
    .split('\n')
    .slice(1)
    .map((line) => /\(?([^\s()]+):(\d+):\d+\)?$/.exec(line.trim()))
    .find((match) => match && !match[1].startsWith('node:') && !match[1].includes('node_modules'));
  return {
    code: frame ? `${error.name} at ${relative(process.cwd(), frame[1])}:${frame[2]}` : error.name,
    detail: error.message,
  };
}

/**
 * Issues `a` and `b` (joined to their urls `au` and `bu`) are one problem when
 * they share a site, page type, kind and problem code. In particular, a login
 * redirect and a missing SKU must never inherit one another's verdict.
 */
export function sameProblem(a: string, au: string, b: string, bu: string): string {
  return `${au}.site_id = ${bu}.site_id and ${au}.type = ${bu}.type and ${a}.kind = ${b}.kind and ${a}.problem = ${b}.problem and ${a}.id <> ${b}.id`;
}

/**
 * Records the findings on a url as one issue, its problem code their codes.
 * Idempotent: recording an open issue again updates its problem and detail, and
 * a page failing again while its issue is triaged leaves that issue as it is. A
 * new issue whose problem already has a verdict takes it, as a copy of the issue
 * that earned it.
 */
export async function recordIssue(
  db: Database,
  url: { id: number | string },
  kind: IssueKind,
  findings: Finding[],
): Promise<void> {
  const problem = [...new Set(findings.map((finding) => finding.code))].sort().join(', ');
  const detail = findings.map((finding) => finding.detail).join('; ');
  const [issue] = await db.query<{ id: number; status: string }[]>(
    `insert into issue (url_id, kind, problem, detail) values (?, ?, ?, ?)
     on conflict (url_id, kind) where status in ('open', 'triaged')
     do update set problem = case when issue.status = 'open' then excluded.problem else issue.problem end,
                   detail = case when issue.status = 'open' then excluded.detail else issue.detail end
     returning id, status`,
    url.id,
    kind,
    problem,
    detail,
  );
  if (issue.status !== 'open') return;
  await db.query(
    `update issue me set status = 'triaged', verdict = twin.verdict, same_as = coalesce(twin.same_as, twin.id)
       from (select i.id, i.verdict, i.same_as
               from issue i join url u on u.id = i.url_id, issue me join url mu on mu.id = me.url_id
              where me.id = ? and ${sameProblem('i', 'u', 'me', 'mu')} and i.status = 'triaged'
                and i.same_as is null and i.verdict is not null
              order by i.id
              limit 1) twin
      where me.id = ? and me.status = 'open'`,
    issue.id,
    issue.id,
  );
}
