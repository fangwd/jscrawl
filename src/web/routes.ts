// HTTP API for crawl data, crawl control, issues and crawler source. MCP
// requests at /mcp are forwarded to the tool server. All API and MCP requests
// require JSCRAWL_API_TOKEN as a bearer token; GET /healthz is public.

import { readFile, stat } from 'fs/promises';
import { IncomingMessage, ServerResponse, request } from 'http';
import { resolve, sep } from 'path';

import { Database } from 'sqlex';

import { domain } from '../core/domain';
import { Response } from '../core/fetch';
import { Config } from '../core/models';
import { fetchSiteImage, MAX_IMAGE_BYTES } from '../core/site-image';
import { agentSkills } from '../core/skills';
import { readOnlyQuery } from '../core/sql';
import { Supervisor, SupervisorError } from '../core/supervisor';
import { runProcesses, systemReport } from '../core/system';
import { describeTables } from '../core/tables';
import * as actions from './api/actions';
import * as proxies from './api/proxies';
import * as read from './api/read';
import * as runs from './api/runs';
import { isService } from './auth';
import { createDomainApi, DOMAIN_API_PATH, serveDomainApi } from './domainApi';
import { digits, readJson, sendJson } from './http';

export interface WebDeps {
  db: Database;
  config: Config;
  supervisor: Supervisor;
  cwd?: string;
  /** The service token callers send as a bearer. */
  apiToken: string;
  /** The tool server's current port, when ready; see entries/server.ts. */
  toolServer?: () => number | undefined;
}

export function webHandler(deps: WebDeps) {
  // compiled once the schema is known, on the first request for it
  let domainApi: ReturnType<typeof createDomainApi> | undefined;
  return async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      // up once the tools are: what anything waiting for jscrawl wants to know
      if (url.pathname === '/healthz' && req.method === 'GET') return toTools(deps, req, res);
      const tools = url.pathname === '/mcp';
      if (!tools && !url.pathname.startsWith('/api/'))
        return sendJson(res, 404, { error: 'Not found' });
      if (!isService(req, deps.apiToken))
        return sendJson(res, 401, { error: 'The service token is required' });
      if (tools) return toTools(deps, req, res);
      if (url.pathname === DOMAIN_API_PATH || url.pathname.startsWith(`${DOMAIN_API_PATH}/`)) {
        if (!deps.db.schema) await deps.db.buildSchema();
        domainApi ??= createDomainApi(deps.db);
        return await serveDomainApi(domainApi, req, res, url);
      }
      return await api(deps, req, res, url);
    } catch (err: any) {
      if (!res.headersSent) sendJson(res, 500, { error: String(err?.message ?? err) });
      else res.end();
    }
  };
}

/** Forwards to the tool server as is, streaming both ways: tool calls can run for minutes. */
function toTools(deps: WebDeps, req: IncomingMessage, res: ServerResponse) {
  const port = deps.toolServer?.();
  if (port === undefined) return sendJson(res, 503, { error: 'The tool server is starting' });
  const upstream = request(
    {
      host: '127.0.0.1',
      port,
      method: req.method,
      path: req.url,
      headers: req.headers,
    },
    (response) => {
      res.writeHead(response.statusCode ?? 502, response.headers);
      response.pipe(res);
    },
  );
  upstream.on('error', (err) => {
    if (!res.headersSent)
      sendJson(res, 503, {
        error: `The tool server is unreachable: ${err.message}`,
      });
    else res.end();
  });
  res.on('close', () => upstream.destroy());
  req.pipe(upstream);
}

/** Rows the dashboard's SQL console returns at most. */
const SQL_MAX_ROWS = 1000;

async function api(deps: WebDeps, req: IncomingMessage, res: ServerResponse, url: URL) {
  const { db, config } = deps;
  const method = req.method ?? 'GET';
  const [, , resource, rawId, sub, extra] = url.pathname.split('/');
  const params = url.searchParams;
  const intParam = (name: string): number | undefined => {
    const value = params.get(name);
    return value === null || value === '' || !/^-?\d+$/.test(value) ? undefined : Number(value);
  };

  if (resource === 'issues' && rawId && method !== 'GET') {
    const issueId = digits(rawId);
    if (issueId === null) return sendJson(res, 400, { error: 'Invalid issue id' });
    if (method === 'PATCH' && !sub) {
      let body: any;
      try {
        body = await readJson(req);
      } catch {
        return sendJson(res, 400, { error: 'body must be JSON' });
      }
      const result = await actions.patchIssue(db, issueId, body);
      return sendJson(res, result.status, result.body);
    }
    return sendJson(res, 405, { error: 'Method not allowed' });
  }

  if (method === 'PATCH' && resource === 'sites' && rawId && !sub) {
    // JSON only: a cross-site form can post text/plain without a preflight
    if (!/^application\/json\b/.test(req.headers['content-type'] ?? '')) {
      return sendJson(res, 415, {
        error: 'Content-Type must be application/json',
      });
    }
    const siteId = digits(rawId);
    if (siteId === null) return sendJson(res, 400, { error: 'Invalid site id' });
    let body: any;
    try {
      body = await readJson(req);
    } catch {
      return sendJson(res, 400, { error: 'body must be JSON' });
    }
    const saved = await actions.patchSite(db, siteId, body);
    if (saved.status !== 200) return sendJson(res, saved.status, saved.body);
    // a running crawl is restarted to take the new settings up; one that cannot be is left running
    let restart: { runId: number } | { skipped: string } | null = null;
    if ((await deps.supervisor.liveCrawl(siteId)) !== null) {
      try {
        restart = { runId: await deps.supervisor.restart(siteId) };
      } catch (err) {
        if (!(err instanceof SupervisorError)) throw err;
        restart = { skipped: err.message };
      }
    }
    return sendJson(res, 200, { ...saved.body, restart });
  }

  if (method === 'PUT' && resource === 'sites' && sub === 'crawler' && extra === undefined) {
    // JSON only: a cross-site form can post text/plain without a preflight
    if (!/^application\/json\b/.test(req.headers['content-type'] ?? '')) {
      return sendJson(res, 415, {
        error: 'Content-Type must be application/json',
      });
    }
    const siteId = digits(rawId);
    const site = siteId === null ? null : await read.siteDetail(db, siteId);
    if (!site) return sendJson(res, 404, { error: `No site ${rawId}` });
    let body: any;
    try {
      body = await readJson(req);
    } catch {
      return sendJson(res, 400, { error: 'body must be JSON' });
    }
    try {
      const result = await actions.saveCrawler(config, site.name, body, deps.cwd);
      return sendJson(
        res,
        result.status,
        result.status === 200 ? { name: site.name, ...result.body } : result.body,
      );
    } catch (err) {
      return fail(res, err);
    }
  }

  if (resource === 'proxies' && rawId && method !== 'GET') {
    const id = decodeURIComponent(rawId);
    const outcome =
      method === 'DELETE' && !sub
        ? await proxies.removeProxy(id)
        : method === 'POST' && sub === 'renew' && !extra
          ? await proxies.renewProxy(id)
          : method === 'POST' && sub === 'check' && !extra
            ? await proxies.checkProxy(id)
            : null;
    if (!outcome) return sendJson(res, 405, { error: 'Method not allowed' });
    return sendJson(res, outcome.status, outcome.body);
  }

  if (method === 'POST') {
    if (resource === 'runs' && sub === 'stop' && !extra) {
      const runId = digits(rawId);
      if (runId === null) return sendJson(res, 400, { error: 'Invalid run id' });
      try {
        await deps.supervisor.stopRun(runId);
        return sendJson(res, 200, { stopped: true });
      } catch (err) {
        return fail(res, err);
      }
    }
    if (resource === 'sql' && !rawId) {
      // JSON only: a cross-site form can post text/plain without a preflight
      if (!/^application\/json\b/.test(req.headers['content-type'] ?? '')) {
        return sendJson(res, 415, {
          error: 'Content-Type must be application/json',
        });
      }
      let body: any;
      try {
        body = await readJson(req);
      } catch {
        return sendJson(res, 400, { error: 'body must be JSON' });
      }
      if (typeof body.query !== 'string' || !body.query.trim())
        return sendJson(res, 400, { error: 'query is required' });
      try {
        return sendJson(res, 200, await readOnlyQuery(db, body.query, { maxRows: SQL_MAX_ROWS }));
      } catch (err: any) {
        return sendJson(res, 400, { error: String(err?.message ?? err) });
      }
    }
    if (
      resource === 'crawlers' &&
      (rawId === 'resume' || rawId === 'recrawl' || rawId === 'reset-failed') &&
      !sub
    ) {
      let body: any;
      try {
        body = await readJson(req);
      } catch {
        return sendJson(res, 400, { error: 'body must be JSON' });
      }
      try {
        if (rawId === 'resume') {
          const stopped = await deps.supervisor.stoppedSites();
          if (body.dry)
            return sendJson(res, 200, {
              sites: await deps.supervisor.idleSites(stopped),
            });
          return sendJson(res, 200, {
            started: await deps.supervisor.startIdle(stopped),
          });
        }
        const onlyFailed = rawId === 'reset-failed';
        if (body.dry) {
          const { affected, siteIds } = await deps.supervisor.resetUrls(null, {
            onlyFailed,
            dry: true,
          });
          return sendJson(res, 200, { affected, siteIds });
        }
        const { affected, siteIds } = await deps.supervisor.resetUrls(null, {
          onlyFailed,
        });
        return sendJson(res, 200, {
          affected,
          started: await deps.supervisor.startIdle(siteIds),
        });
      } catch (err) {
        return fail(res, err);
      }
    }
    if (
      resource === 'crawlers' &&
      rawId &&
      (sub === 'start' || sub === 'stop' || sub === 'restart')
    ) {
      const siteId = await resolveSite(deps.supervisor, rawId);
      if (siteId === null) return sendJson(res, 404, { error: `No site ${rawId}` });
      try {
        if (sub === 'start')
          return sendJson(res, 200, {
            runId: await deps.supervisor.start(siteId),
          });
        if (sub === 'stop') {
          await deps.supervisor.stop(siteId);
          return sendJson(res, 200, { stopped: true });
        }
        return sendJson(res, 200, {
          runId: await deps.supervisor.restart(siteId),
        });
      } catch (err) {
        return fail(res, err);
      }
    }
    if (resource === 'urls' && rawId && sub === 'rescrape') {
      const urlId = digits(rawId);
      if (urlId === null) return sendJson(res, 400, { error: 'Invalid url id' });
      let body: any;
      try {
        body = await readJson(req);
      } catch {
        return sendJson(res, 400, { error: 'body must be JSON' });
      }
      const mode = body.mode ?? 'queue';
      if (mode !== 'queue' && mode !== 'oneshot')
        return sendJson(res, 400, { error: 'mode must be queue or oneshot' });
      try {
        return sendJson(res, 200, await deps.supervisor.rescrape(urlId, mode));
      } catch (err) {
        return fail(res, err);
      }
    }
    if (resource === 'urls' && rawId && sub === 'live-check' && extra === undefined) {
      const urlId = digits(rawId);
      if (urlId === null) return sendJson(res, 400, { error: 'Invalid url id' });
      if (!domain().liveCheck)
        return sendJson(res, 404, { error: 'This domain has no live check' });
      const result = await actions.liveCheckChild(urlId, deps.cwd);
      return sendJson(res, result.status, result.body);
    }
    if (resource === 'sites' && rawId && sub === 'reset-urls') {
      const siteId = await resolveSite(deps.supervisor, rawId);
      if (siteId === null) return sendJson(res, 404, { error: `No site ${rawId}` });
      let body: any;
      try {
        body = await readJson(req);
      } catch {
        return sendJson(res, 400, { error: 'body must be JSON' });
      }
      try {
        const { affected } = await deps.supervisor.resetUrls(siteId, {
          onlyFailed: !!body.onlyFailed,
          dry: !!body.dry,
        });
        return sendJson(res, 200, { affected });
      } catch (err) {
        return fail(res, err);
      }
    }
    return sendJson(res, 404, { error: 'Not found' });
  }

  if (method !== 'GET') return sendJson(res, 405, { error: 'Method not allowed' });

  if (resource === 'domain' && !rawId) {
    const { name, urlTypes, inspectTool, feed, liveCheck, ui } = domain();
    return sendJson(res, 200, {
      name,
      urlTypes,
      inspectTool,
      feed: !!feed,
      liveCheck: !!liveCheck,
      ui: ui ?? {},
    });
  }

  if (resource === 'skills' && !rawId) return sendJson(res, 200, await agentSkills());

  if (resource === 'proxies' && !rawId)
    return sendJson(res, 200, await proxies.proxiesOverview(db));

  if (resource === 'system' && !rawId) {
    const cwd = deps.cwd ?? process.cwd();
    const paths: { [what: string]: string } = {
      checkout: cwd,
      logs: deps.supervisor.logDir,
    };
    if (config.store?.html) paths['saved pages'] = resolve(cwd, config.store.html);
    if (config.store?.images) paths['saved images'] = resolve(cwd, config.store.images);
    return sendJson(res, 200, await systemReport(db, paths, await deps.supervisor.running()));
  }

  if (resource === 'docs' && rawId === 'feed-format' && !sub) {
    const docs = domain().feed?.docs;
    if (!docs) return sendJson(res, 404, { error: 'This domain has no feed' });
    const text = await readFile(docs, 'utf8');
    res.writeHead(200, {
      'content-type': 'text/markdown; charset=utf-8',
      'cache-control': 'no-cache',
    });
    return res.end(text);
  }

  if (resource === 'runs') {
    if (!rawId) {
      return sendJson(
        res,
        200,
        await runs.listRuns(db, {
          siteId: intParam('siteId'),
          status: params.get('status') ?? undefined,
          kind: params.get('kind') ?? undefined,
          page: intParam('page'),
          pageSize: intParam('pageSize'),
        }),
      );
    }
    const runId = digits(rawId);
    if (runId === null) return sendJson(res, 400, { error: 'Invalid run id' });
    if (sub === 'fetches' && !extra) {
      return sendJson(
        res,
        200,
        await runs.runFetches(db, runId, {
          failed: params.get('failed') === '1',
          page: intParam('page'),
          pageSize: intParam('pageSize'),
        }),
      );
    }
    const run =
      sub === undefined || (sub === 'process' && !extra)
        ? await runs.runDetail(db, runId)
        : undefined;
    if (run === undefined) return sendJson(res, 404, { error: 'Not found' });
    if (run === null) return sendJson(res, 404, { error: `No run ${runId}` });
    if (!sub) return sendJson(res, 200, run);
    // the processes of a run can be listed while it goes on, on the host it runs on
    const where = {
      id: run.id,
      siteId: run.siteId,
      siteName: run.siteName,
      kind: run.kind,
      pid: run.pid,
      host: run.host,
    };
    const unavailable = !run.live
      ? `run ${runId} is over`
      : !run.local || run.pid == null
        ? `run ${runId} runs on ${run.host ?? 'another host'}: its processes are listed there`
        : null;
    const processes = unavailable ? null : await runProcesses(run.pid!);
    return sendJson(res, 200, {
      run: where,
      processes: processes ?? [],
      unavailable: unavailable ?? (processes ? null : `process ${run.pid} is gone`),
    });
  }

  if (resource === 'crawlers') {
    if (!rawId) return sendJson(res, 200, { crawlers: await deps.supervisor.status() });
    const siteId = await resolveSite(deps.supervisor, rawId);
    if (siteId === null) return sendJson(res, 404, { error: `No site ${rawId}` });
    if (sub === 'runs') return sendJson(res, 200, { runs: await deps.supervisor.runs(siteId) });
    if (sub === 'log') {
      const runId = intParam('runId');
      try {
        // tail=1 serves the end of the log; otherwise the caller reads from an
        // offset: forward to the end (a live tail), or `limit` bytes (paging back).
        if (params.get('tail'))
          return sendJson(res, 200, await deps.supervisor.logTail(siteId, runId));
        let target = runId;
        if (target === undefined) {
          const [latest] = await deps.supervisor.runs(siteId, 1);
          target = latest?.id;
          if (target === undefined) return sendJson(res, 404, { error: 'No runs for this site' });
        }
        return sendJson(
          res,
          200,
          await deps.supervisor.log(target, intParam('offset') ?? 0, intParam('limit')),
        );
      } catch (err) {
        return fail(res, err);
      }
    }
    return sendJson(res, 404, { error: 'Not found' });
  }

  if (resource === 'overview' && !rawId) {
    const sites = await read.sitesOverview(db);
    const totals = {
      sites: sites.length,
      urls: sites.reduce((n, s) => n + sum(s.urls), 0),
      openIssues: sites.reduce((n, s) => n + s.issues.open, 0),
    };
    return sendJson(res, 200, { sites, totals });
  }

  // a site's image as its crawler fetches it - through the site's proxy - for an import elsewhere
  if (resource === 'sites' && rawId && sub === 'image' && extra === undefined) {
    const url = new URL(req.url ?? '/', 'http://localhost').searchParams.get('url');
    if (!url) return sendJson(res, 400, { error: 'Give the image url: ?url=' });
    const image = await fetchSiteImage(db, rawId, url);
    if (!image) return sendJson(res, 404, { error: 'The site has no such image url' });
    if (image.statusCode >= 400)
      return sendJson(res, 502, {
        error: `The site answered HTTP ${image.statusCode}`,
      });
    if (!/^image\//i.test(image.contentType))
      return sendJson(res, 502, {
        error: `The site answered ${image.contentType || 'no content type'}, not an image`,
      });
    if (image.body.length > MAX_IMAGE_BYTES)
      return sendJson(res, 502, {
        error: `The image is over ${MAX_IMAGE_BYTES / 1e6} MB`,
      });
    res.writeHead(200, {
      'content-type': image.contentType,
      'content-length': image.body.length,
      'cache-control': 'no-store',
    });
    return res.end(image.body);
  }

  if (resource === 'sites') {
    const siteId = digits(rawId);
    if (siteId === null) return sendJson(res, 400, { error: 'Invalid site id' });
    if (sub === 'crawler') {
      const site = await read.siteDetail(db, siteId);
      if (!site) return sendJson(res, 404, { error: `No site ${siteId}` });
      try {
        return sendJson(res, 200, {
          name: site.name,
          ...(await read.crawlerSource(config, site.name, deps.cwd)),
        });
      } catch (err) {
        return sendJson(res, 404, {
          error: String(err instanceof Error ? err.message : err),
        });
      }
    }
    if (sub === 'feed.zip' && extra === undefined) {
      const feed = domain().feed;
      if (!feed) return sendJson(res, 404, { error: 'This domain has no feed' });
      const site = await read.siteDetail(db, siteId);
      if (!site) return sendJson(res, 404, { error: `No site ${siteId}` });
      try {
        const { bytes } = await feed.export(site.id, db as any);
        res.writeHead(200, {
          'content-type': feed.contentType,
          'content-disposition': `attachment; filename="${feed.filename(site)}"`,
          'cache-control': 'no-store',
        });
        return res.end(bytes);
      } catch (err: any) {
        return sendJson(res, 409, { error: String(err?.message ?? err) });
      }
    }
    if (sub === 'urls' || sub === undefined) {
      if (sub === undefined) {
        const site = await read.siteDetail(db, siteId);
        return site ? sendJson(res, 200, site) : sendJson(res, 404, { error: `No site ${siteId}` });
      }
      return sendJson(
        res,
        200,
        await read.listUrls(db, {
          siteId,
          type: params.get('type') ?? undefined,
          status: intParam('status'),
          q: params.get('q') ?? undefined,
          page: intParam('page'),
          pageSize: intParam('pageSize'),
        }),
      );
    }
    return sendJson(res, 404, { error: 'Not found' });
  }

  if (resource === 'urls') {
    if (!rawId) {
      return sendJson(
        res,
        200,
        await read.listUrls(db, {
          siteId: intParam('siteId'),
          type: params.get('type') ?? undefined,
          excludeType: params.get('excludeType') ?? undefined,
          status: intParam('status'),
          q: params.get('q') ?? undefined,
          page: intParam('page'),
          pageSize: intParam('pageSize'),
        }),
      );
    }
    const urlId = digits(rawId);
    if (urlId === null) return sendJson(res, 400, { error: 'Invalid url id' });
    if (!sub) {
      const detail = await read.urlDetail(db, config, urlId, deps.cwd);
      return detail ? sendJson(res, 200, detail) : sendJson(res, 404, { error: `No url ${urlId}` });
    }
    if (sub === 'snapshot') {
      return snapshot(deps, res, urlId, extra);
    }
    return sendJson(res, 404, { error: 'Not found' });
  }

  if (resource === 'schema' && !rawId) {
    return sendJson(res, 200, {
      tables: describeTables(await db.buildSchema()),
    });
  }

  if (resource === 'problems' && !rawId) {
    return sendJson(res, 200, { problems: await read.openProblems(db) });
  }

  if (resource === 'issues') {
    if (!rawId) {
      return sendJson(
        res,
        200,
        await read.listIssues(db, {
          status: params.get('status') ?? undefined,
          verdict: params.get('verdict') ?? undefined,
          kind: params.get('kind') ?? undefined,
          originals: params.get('originals') === '1',
          siteId: intParam('siteId'),
          page: intParam('page'),
          pageSize: intParam('pageSize'),
        }),
      );
    }
    const issueId = digits(rawId);
    if (issueId === null) return sendJson(res, 400, { error: 'Invalid issue id' });
    const issue = await read.issueDetail(db, issueId);
    return issue ? sendJson(res, 200, issue) : sendJson(res, 404, { error: `No issue ${issueId}` });
  }

  return sendJson(res, 404, { error: 'Not found' });
}

function sum(urls: { [type: string]: { [status: string]: number } }): number {
  let total = 0;
  for (const byStatus of Object.values(urls)) for (const n of Object.values(byStatus)) total += n;
  return total;
}

/** Site by numeric id or exact name; null when unknown. */
async function resolveSite(supervisor: Supervisor, raw: string): Promise<number | null> {
  try {
    return (await supervisor.resolveSite(raw)).id;
  } catch {
    return null;
  }
}

function fail(res: ServerResponse, err: unknown) {
  if (err instanceof SupervisorError) return sendJson(res, err.status, { error: err.message });
  throw err;
}

/** Serves a saved page (yareq container format) as inert HTML: sandboxed, no sniffing. */
async function snapshot(
  deps: WebDeps,
  res: ServerResponse,
  urlId: number,
  version: string | undefined,
) {
  const dir = deps.config.store?.html;
  if (!dir || !version || !/^\d+$/.test(version))
    return sendJson(res, 404, { error: 'No such snapshot' });
  const root = resolve(deps.cwd ?? process.cwd(), dir);
  const file = resolve(root, `${urlId}.${version}`);
  if (file !== resolve(root, `${urlId}.${version}`) || !file.startsWith(root + sep)) {
    return sendJson(res, 400, { error: 'Invalid snapshot' });
  }
  if (!(await isFile(file))) return sendJson(res, 404, { error: 'No such snapshot' });
  const response = await Response.load(file);
  res.writeHead(200, {
    'content-type': response.contentType || 'text/html; charset=utf-8',
    'content-security-policy': 'sandbox',
    'x-content-type-options': 'nosniff',
    'cache-control': 'no-store',
  });
  res.end(response.body);
}

const isFile = (path: string) =>
  stat(path)
    .then((s) => s.isFile())
    .catch(() => false);
