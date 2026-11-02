// jscrawl's HTTP API: crawl data, crawl control, issues and the crawler code, for
// its one caller - spidermake, which serves the dashboard and signs people in -
// and for scripts, plus the agent's tools at /mcp, forwarded to the tool server.
// Every route needs the service token (JSCRAWL_API_TOKEN) as a bearer, except
// GET /healthz.

import { readFile, stat } from 'fs/promises';
import { IncomingMessage, ServerResponse, request } from 'http';
import { resolve, sep } from 'path';
import { Database } from 'sqlex';
import { Response } from '../core/fetch';
import { exportFeed, feedZip } from '../core/feed';
import { inspectProduct, inspectUrl } from '../core/inspect';
import { Config } from '../core/models';
import { readOnlyQuery, tableColumns } from '../core/sql';
import { Supervisor, SupervisorError } from '../core/supervisor';
import * as actions from './api/actions';
import { isService } from './auth';
import * as read from './api/read';

export interface WebDeps {
  db: Database;
  config: Config;
  supervisor: Supervisor;
  cwd?: string;
  /** The service token callers send as a bearer. */
  apiToken: string;
  /** The tool server's port, while it is up (see src/server.ts). */
  toolServer?: () => number | undefined;
}

export function webHandler(deps: WebDeps) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      // up once the tools are: what anything waiting for jscrawl wants to know
      if (url.pathname === '/healthz' && req.method === 'GET') return toTools(deps, req, res);
      const tools = url.pathname === '/mcp';
      if (!tools && !url.pathname.startsWith('/api/')) return sendJson(res, 404, { error: 'Not found' });
      if (!isService(req, deps.apiToken)) return sendJson(res, 401, { error: 'The service token is required' });
      if (tools) return toTools(deps, req, res);
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
    { host: '127.0.0.1', port, method: req.method, path: req.url, headers: req.headers },
    (response) => {
      res.writeHead(response.statusCode ?? 502, response.headers);
      response.pipe(res);
    }
  );
  upstream.on('error', (err) => {
    if (!res.headersSent) sendJson(res, 503, { error: `The tool server is unreachable: ${err.message}` });
    else res.end();
  });
  res.on('close', () => upstream.destroy());
  req.pipe(upstream);
}

function sendJson(res: ServerResponse, status: number, body?: unknown) {
  const text = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(text);
}

async function readJson(req: IncomingMessage): Promise<any> {
  let body = '';
  for await (const chunk of req) body += chunk;
  if (!body) return {};
  return JSON.parse(body);
}

/** Rows the dashboard's SQL console returns at most. */
const SQL_MAX_ROWS = 1000;

const digits = (value: string | undefined): number | null =>
  value !== undefined && /^\d+$/.test(value) ? Number(value) : null;

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

  if (method === 'PUT' && resource === 'sites' && sub === 'crawler' && extra === undefined) {
    // JSON only: a cross-site form can post text/plain without a preflight
    if (!/^application\/json\b/.test(req.headers['content-type'] ?? '')) {
      return sendJson(res, 415, { error: 'Content-Type must be application/json' });
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
      return sendJson(res, result.status, result.status === 200 ? { name: site.name, ...result.body } : result.body);
    } catch (err) {
      return fail(res, err);
    }
  }

  if (method === 'POST') {
    if (resource === 'sql' && !rawId) {
      // JSON only: a cross-site form can post text/plain without a preflight
      if (!/^application\/json\b/.test(req.headers['content-type'] ?? '')) {
        return sendJson(res, 415, { error: 'Content-Type must be application/json' });
      }
      let body: any;
      try {
        body = await readJson(req);
      } catch {
        return sendJson(res, 400, { error: 'body must be JSON' });
      }
      if (typeof body.query !== 'string' || !body.query.trim()) return sendJson(res, 400, { error: 'query is required' });
      try {
        return sendJson(res, 200, await readOnlyQuery(db, body.query, { maxRows: SQL_MAX_ROWS }));
      } catch (err: any) {
        return sendJson(res, 400, { error: String(err?.message ?? err) });
      }
    }
    if (resource === 'crawlers' && (rawId === 'resume' || rawId === 'recrawl' || rawId === 'reset-failed') && !sub) {
      let body: any;
      try {
        body = await readJson(req);
      } catch {
        return sendJson(res, 400, { error: 'body must be JSON' });
      }
      try {
        if (rawId === 'resume') {
          const stopped = await deps.supervisor.stoppedSites();
          if (body.dry) return sendJson(res, 200, { sites: await deps.supervisor.idleSites(stopped) });
          return sendJson(res, 200, { started: await deps.supervisor.startIdle(stopped) });
        }
        const onlyFailed = rawId === 'reset-failed';
        if (body.dry) {
          const { affected, siteIds } = await deps.supervisor.resetUrls(null, { onlyFailed, dry: true });
          return sendJson(res, 200, { affected, siteIds });
        }
        const { affected, siteIds } = await deps.supervisor.resetUrls(null, { onlyFailed });
        return sendJson(res, 200, { affected, started: await deps.supervisor.startIdle(siteIds) });
      } catch (err) {
        return fail(res, err);
      }
    }
    if (resource === 'crawlers' && rawId && (sub === 'start' || sub === 'stop' || sub === 'restart')) {
      const siteId = await resolveSite(deps.supervisor, rawId);
      if (siteId === null) return sendJson(res, 404, { error: `No site ${rawId}` });
      try {
        if (sub === 'start') return sendJson(res, 200, { runId: await deps.supervisor.start(siteId) });
        if (sub === 'stop') {
          await deps.supervisor.stop(siteId);
          return sendJson(res, 200, { stopped: true });
        }
        return sendJson(res, 200, { runId: await deps.supervisor.restart(siteId) });
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
      if (mode !== 'queue' && mode !== 'oneshot') return sendJson(res, 400, { error: 'mode must be queue or oneshot' });
      try {
        return sendJson(res, 200, await deps.supervisor.rescrape(urlId, mode));
      } catch (err) {
        return fail(res, err);
      }
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
        const { affected } = await deps.supervisor.resetUrls(siteId, { onlyFailed: !!body.onlyFailed, dry: !!body.dry });
        return sendJson(res, 200, { affected });
      } catch (err) {
        return fail(res, err);
      }
    }
    return sendJson(res, 404, { error: 'Not found' });
  }

  if (method !== 'GET') return sendJson(res, 405, { error: 'Method not allowed' });

  if (resource === 'docs' && rawId === 'feed-format' && !sub) {
    const text = await readFile(resolve(deps.cwd ?? process.cwd(), 'docs/feed-format.md'), 'utf8');
    res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8', 'cache-control': 'no-cache' });
    return res.end(text);
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
        if (params.get('tail')) return sendJson(res, 200, await deps.supervisor.logTail(siteId, runId));
        let target = runId;
        if (target === undefined) {
          const [latest] = await deps.supervisor.runs(siteId, 1);
          target = latest?.id;
          if (target === undefined) return sendJson(res, 404, { error: 'No runs for this site' });
        }
        return sendJson(res, 200, await deps.supervisor.log(target, intParam('offset') ?? 0, intParam('limit')));
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
      products: sites.reduce((n, s) => n + s.products, 0),
      openIssues: sites.reduce((n, s) => n + s.issues.open, 0),
    };
    return sendJson(res, 200, { sites, totals });
  }

  if (resource === 'sites') {
    const siteId = digits(rawId);
    if (siteId === null) return sendJson(res, 400, { error: 'Invalid site id' });
    if (sub === 'crawler') {
      const site = await read.siteDetail(db, siteId);
      if (!site) return sendJson(res, 404, { error: `No site ${siteId}` });
      try {
        return sendJson(res, 200, { name: site.name, ...(await read.crawlerSource(config, site.name, deps.cwd)) });
      } catch (err) {
        return sendJson(res, 404, { error: String(err instanceof Error ? err.message : err) });
      }
    }
    if (sub === 'categories') {
      return sendJson(res, 200, { categories: await read.siteCategories(db, siteId) });
    }
    if (sub === 'products') {
      return sendJson(
        res,
        200,
        await read.listProducts(db, siteId, {
          categoryId: intParam('categoryId'),
          q: params.get('q') ?? undefined,
          page: intParam('page'),
          pageSize: intParam('pageSize'),
        })
      );
    }
    if (sub === 'feed.zip' && extra === undefined) {
      const site = await read.siteDetail(db, siteId);
      if (!site) return sendJson(res, 404, { error: `No site ${siteId}` });
      try {
        const zip = feedZip(await exportFeed(db, site.name));
        res.writeHead(200, {
          'content-type': 'application/zip',
          'content-disposition': `attachment; filename="${site.name}-feed.zip"`,
          'cache-control': 'no-store',
        });
        return res.end(zip);
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
        })
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
          status: intParam('status'),
          q: params.get('q') ?? undefined,
          page: intParam('page'),
          pageSize: intParam('pageSize'),
        })
      );
    }
    const urlId = digits(rawId);
    if (urlId === null) return sendJson(res, 400, { error: 'Invalid url id' });
    if (!sub) {
      const detail = await read.urlDetail(db, config, urlId, deps.cwd);
      return detail ? sendJson(res, 200, detail) : sendJson(res, 404, { error: `No url ${urlId}` });
    }
    if (sub === 'data') {
      const report = await inspectUrl(db, urlId);
      return report ? sendJson(res, 200, report) : sendJson(res, 404, { error: `No url ${urlId}` });
    }
    if (sub === 'live') {
      const [row] = await db.query<{ url: string }[]>('select url from url where id = ?', urlId);
      if (!row) return sendJson(res, 404, { error: `No url ${urlId}` });
      return sendJson(res, 200, await read.liveProduct(row.url));
    }
    if (sub === 'snapshot') {
      return snapshot(deps, res, urlId, extra);
    }
    return sendJson(res, 404, { error: 'Not found' });
  }

  if (resource === 'products' && rawId && !sub) {
    const productId = digits(rawId);
    if (productId === null) return sendJson(res, 400, { error: 'Invalid product id' });
    const report = await inspectProduct(db, productId);
    return report ? sendJson(res, 200, report) : sendJson(res, 404, { error: `No product ${productId}` });
  }

  if (resource === 'sql' && rawId === 'schema') {
    return sendJson(res, 200, { tables: Object.fromEntries(await tableColumns(db)) });
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
        })
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
async function snapshot(deps: WebDeps, res: ServerResponse, urlId: number, version: string | undefined) {
  const dir = deps.config.store?.html;
  if (!dir || !version || !/^\d+$/.test(version)) return sendJson(res, 404, { error: 'No such snapshot' });
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

const isFile = (path: string) => stat(path).then((s) => s.isFile()).catch(() => false);
