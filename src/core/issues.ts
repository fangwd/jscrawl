// The problems crawls find, recorded as `issue` rows for people and agents to
// triage. An agent works through the open problems (GET /api/problems) and
// records its verdict with jscrawl_resolveIssue; nothing here calls one.

import { Database } from 'sqlex';

export type IssueKind = 'scrape_failed' | 'validation' | 'acceptance' | 'regression' | 'blocked';

/**
 * Issues `a` and `b` (joined to their urls `au` and `bu`) are one problem when
 * they share a site, page type and kind: a failing template usually fails every
 * page it renders, so the problem is investigated once and its verdict settles
 * the rest.
 */
export function sameProblem(a: string, au: string, b: string, bu: string): string {
  return `${au}.site_id = ${bu}.site_id and ${au}.type = ${bu}.type and ${a}.kind = ${b}.kind and ${a}.id <> ${b}.id`;
}

/**
 * Records a problem with a url. Idempotent: recording an open issue again updates
 * its detail, and a page failing again while its issue is triaged leaves that
 * issue as it is. A new issue whose problem already has a verdict takes it, as a
 * copy of the issue that earned it.
 */
export async function recordIssue(db: Database, url: { id: number | string }, kind: IssueKind, detail: string): Promise<void> {
  const [issue] = await db.query<{ id: number; status: string }[]>(
    `insert into issue (url_id, kind, detail) values (?, ?, ?)
     on conflict (url_id, kind) where status in ('open', 'triaged')
     do update set detail = case when issue.status = 'open' then excluded.detail else issue.detail end
     returning id, status`,
    url.id,
    kind,
    detail
  );
  if (issue.status !== 'open') return;
  await db.query(
    `update issue me set status = 'triaged', verdict = twin.verdict, same_as = coalesce(twin.same_as, twin.id)
       from (select i.id, i.verdict, i.same_as
               from issue i join url u on u.id = i.url_id, issue me join url mu on mu.id = me.url_id
              where me.id = ? and ${sameProblem('i', 'u', 'me', 'mu')} and i.status = 'triaged'
              order by i.id
              limit 1) twin
      where me.id = ? and me.status = 'open'`,
    issue.id,
    issue.id
  );
}
