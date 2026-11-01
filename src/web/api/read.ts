// Read queries for the web API: fixed, parameterized SQL over the crawler
// database (the browser never sends SQL). Shapes are JSON-ready: camelCase
// where assembled, numbers coerced from Postgres' bigint/numeric strings.

import { existsSync } from 'fs';
import { readFile } from 'fs/promises';
import { relative, resolve } from 'path';
import { Database } from 'sqlex';
import { parse } from 'gumbo-html';
import { request } from 'yareq';
import { REQUEST_HEADERS } from '../../core/crawler';
import { jsonLd, productFromJsonLd } from '../../core/extract';
import { listSnapshots } from '../../core/inspect';
import { Config } from '../../core/models';
import { siteModulePath } from '../../core/sites';
import { sha1 } from '../../core/utils';

// url.status as stable keys for the UI (see UrlStatus in src/core/models.ts).
export const URL_STATUS_KEY: { [code: number]: string } = {
  [-2]: 'scrape_failed',
  [-1]: 'fetch_failed',
  0: 'idle',
  1: 'busy',
  2: 'done',
  3: 'disallowed',
};

const num = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value));
const statusKey = (status: number) => URL_STATUS_KEY[status] ?? String(status);

export interface Page<T> {
  total: number;
  page: number;
  pageSize: number;
  rows: T[];
}

function pageParams(page?: number, pageSize?: number) {
  const size = Math.min(Math.max(Math.trunc(pageSize ?? 50), 1), 200);
  const p = Math.max(Math.trunc(page ?? 1), 1);
  return { size, p, offset: (p - 1) * size };
}

/** Every site with its url counts by type x status, product count and issue counts. */
export async function sitesOverview(db: Database) {
  const [sites, urlCounts, productCounts, issueCounts] = await Promise.all([
    db.query<any[]>(
      `select s.id, s.name, s.currency, s.locale,
              c.wait_time, c.random_wait, c.thread_count, c.max_retry_count, c.use_puppeteer, c.page_snapshots
         from site s left join crawler c on c.id = s.crawler_id
        order by s.name`
    ),
    db.query<any[]>('select site_id, type, status, count(*) as n from url group by site_id, type, status'),
    db.query<any[]>('select site_id, count(*) as n from product group by site_id'),
    // pages per status, plus the distinct problems behind them: an open problem is
    // a page type and kind under investigation, a triaged one a verdict awaiting review
    db.query<any[]>(
      `select u.site_id, i.status, count(*) as n,
              count(distinct (u.type, i.kind)) as groups,
              count(*) filter (where i.same_as is null) as originals
         from issue i join url u on u.id = i.url_id
        group by u.site_id, i.status`
    ),
  ]);
  return sites.map((s) => {
    const id = Number(s.id);
    const urls: { [type: string]: { [status: string]: number } } = {};
    for (const row of urlCounts.filter((r) => Number(r.site_id) === id)) {
      (urls[row.type] ??= {})[statusKey(row.status)] = Number(row.n);
    }
    const issues = { open: 0, triaged: 0, resolved: 0, ignored: 0 };
    const problems = { open: 0, triaged: 0 };
    for (const row of issueCounts.filter((r) => Number(r.site_id) === id)) {
      if (row.status in issues) issues[row.status as keyof typeof issues] = Number(row.n);
      if (row.status === 'open') problems.open = Number(row.groups);
      if (row.status === 'triaged') problems.triaged = Number(row.originals);
    }
    return {
      id,
      name: s.name,
      currency: s.currency?.trim() || null,
      locale: s.locale,
      crawler:
        s.wait_time === null || s.wait_time === undefined
          ? null
          : {
              waitTime: s.wait_time,
              randomWait: s.random_wait,
              threadCount: s.thread_count,
              maxRetryCount: s.max_retry_count,
              usePuppeteer: s.use_puppeteer,
              pageSnapshots: s.page_snapshots,
            },
      urls,
      products: Number(productCounts.find((r) => Number(r.site_id) === id)?.n ?? 0),
      issues,
      problems,
    };
  });
}

export async function siteDetail(db: Database, id: number) {
  const site = (await sitesOverview(db)).find((s) => s.id === Number(id));
  if (!site) return null;
  return site;
}

/** The site's crawler file, absolute: `<sites dir>/<name>.ts`, or `.js`. */
export function crawlerFile(config: Config, name: string): string {
  const base = siteModulePath(name, config);
  return existsSync(`${base}.ts`) ? `${base}.ts` : `${base}.js`;
}

/** The site's crawler source; `hash` names this version, so a save can tell it was changed meanwhile. */
export async function crawlerSource(config: Config, name: string, cwd = process.cwd()) {
  const file = crawlerFile(config, name);
  const code = await readFile(file, 'utf8');
  return { file: relative(cwd, file), code, hash: sha1(code) };
}

export interface UrlFilter {
  siteId?: number;
  type?: string;
  status?: number;
  q?: string;
  page?: number;
  pageSize?: number;
}

export async function listUrls(db: Database, filter: UrlFilter): Promise<Page<any>> {
  const where: string[] = [];
  const args: unknown[] = [];
  if (filter.siteId !== undefined) {
    where.push('u.site_id = ?');
    args.push(filter.siteId);
  }
  if (filter.type) {
    where.push('u.type = ?');
    args.push(filter.type);
  }
  if (filter.status !== undefined) {
    where.push('u.status = ?');
    args.push(filter.status);
  }
  if (filter.q) {
    where.push('u.url ilike ?');
    args.push(`%${filter.q}%`);
  }
  const clause = where.length ? `where ${where.join(' and ')}` : '';
  const { size, p, offset } = pageParams(filter.page, filter.pageSize);
  const [count] = await db.query<any[]>(`select count(*) as n from url u ${clause}`, ...args);
  const rows = await db.query<any[]>(
    `select u.id, u.site_id, s.name as site_name, u.url, u.type, u.status, u.version, u.visit_time,
            (select f.http_status from url_fetch f where f.url_id = u.id order by f.fetch_time desc limit 1) as http_status,
            (select f.error from url_fetch f where f.url_id = u.id order by f.fetch_time desc limit 1) as fetch_error
       from url u join site s on s.id = u.site_id
       ${clause}
      order by u.id
      limit ? offset ?`,
    ...args,
    size,
    offset
  );
  return {
    total: Number(count.n),
    page: p,
    pageSize: size,
    rows: rows.map((u) => ({
      id: Number(u.id),
      siteId: Number(u.site_id),
      siteName: u.site_name,
      url: u.url,
      type: u.type,
      status: u.status,
      version: u.version,
      visitTime: u.visit_time,
      httpStatus: num(u.http_status),
      fetchError: u.fetch_error ?? null,
    })),
  };
}

/** One url with everything around it: fetches, inbound links, issues, snapshot versions. */
export async function urlDetail(db: Database, config: Config, id: number, cwd = process.cwd()) {
  const [url] = await db.query<any[]>(
    `select u.id, u.site_id, s.name as site_name, s.currency, u.type, u.status, u.version,
            u.url, u.visit_time, u.priority, u.hash
       from url u join site s on s.id = u.site_id
      where u.id = ?`,
    id
  );
  if (!url) return null;
  const [fetches, inbound, issues, queued] = await Promise.all([
    db.query<any[]>(
      `select fetch_time, http_status, final_url, error, content_type, content_length, fetch_duration
         from url_fetch where url_id = ? order by fetch_time desc limit 20`,
      id
    ),
    db.query<any[]>(
      `select src.id, src.url, src.type from url_graph g
         join url src on src.id = g.src_id
        where g.dst_id = ? order by src.id limit 50`,
      id
    ),
    db.query<any[]>(
      `select id, kind, status, verdict, detail, created_at, resolved_at
         from issue where url_id = ? order by id desc`,
      id
    ),
    db.query<any[]>(
      `select d.id, d.url, d.type, d.status from url_graph g
         join url d on d.id = g.dst_id
        where g.src_id = ? order by d.id limit 100`,
      id
    ),
  ]);
  const snapshots = config.store?.html ? await listSnapshots(resolve(cwd, config.store.html), id) : [];
  return {
    url: {
      id: Number(url.id),
      siteId: Number(url.site_id),
      siteName: url.site_name,
      currency: url.currency?.trim() || null,
      type: url.type,
      status: url.status,
      statusKey: statusKey(url.status),
      version: url.version,
      url: url.url,
      visitTime: url.visit_time,
      priority: url.priority,
      hash: url.hash,
    },
    fetches: fetches.map((f) => ({
      fetchTime: f.fetch_time,
      httpStatus: num(f.http_status),
      finalUrl: f.final_url ?? null,
      error: f.error ?? null,
      contentType: f.content_type ?? null,
      contentLength: num(f.content_length),
      fetchDuration: num(f.fetch_duration),
    })),
    inbound: inbound.map((u) => ({ id: Number(u.id), url: u.url, type: u.type })),
    queued: queued.map((u) => ({ id: Number(u.id), url: u.url, type: u.type, status: u.status })),
    issues: issues.map((i) => ({
      id: Number(i.id),
      kind: i.kind,
      status: i.status,
      verdict: i.verdict ?? null,
      detail: i.detail,
      createdAt: i.created_at,
      resolvedAt: i.resolved_at,
    })),
    snapshotVersions: snapshots.map((name) => name.slice(String(url.id).length + 1)),
  };
}

export interface IssueFilter {
  status?: string;
  verdict?: string;
  siteId?: number;
  kind?: string;
  /** Only the issues that took no other issue's verdict. */
  originals?: boolean;
  page?: number;
  pageSize?: number;
}

export async function listIssues(db: Database, filter: IssueFilter): Promise<Page<any>> {
  const where: string[] = [];
  const args: unknown[] = [];
  if (filter.status) {
    where.push('i.status = ?');
    args.push(filter.status);
  }
  if (filter.verdict) {
    where.push('i.verdict = ?');
    args.push(filter.verdict);
  }
  if (filter.kind) {
    where.push('i.kind = ?');
    args.push(filter.kind);
  }
  if (filter.siteId !== undefined) {
    where.push('u.site_id = ?');
    args.push(filter.siteId);
  }
  if (filter.originals) where.push('i.same_as is null');
  const clause = where.length ? `where ${where.join(' and ')}` : '';
  const { size, p, offset } = pageParams(filter.page, filter.pageSize);
  const [count] = await db.query<any[]>(
    `select count(*) as n from issue i join url u on u.id = i.url_id ${clause}`,
    ...args
  );
  const rows = await db.query<any[]>(
    `select i.id, i.kind, i.status, i.verdict, left(i.detail, 200) as detail, i.created_at, i.resolved_at,
            (select count(*) from issue c where c.same_as = i.id) as copies,
            u.id as url_id, u.url, u.type as url_type, s.id as site_id, s.name as site_name
       from issue i
       join url u on u.id = i.url_id
       join site s on s.id = u.site_id
       ${clause}
      order by i.id desc
      limit ? offset ?`,
    ...args,
    size,
    offset
  );
  return {
    total: Number(count.n),
    page: p,
    pageSize: size,
    rows: rows.map((i) => ({
      id: Number(i.id),
      kind: i.kind,
      status: i.status,
      verdict: i.verdict ?? null,
      detail: i.detail,
      createdAt: i.created_at,
      resolvedAt: i.resolved_at,
      copies: Number(i.copies),
      urlId: Number(i.url_id),
      url: i.url,
      urlType: i.url_type,
      siteId: Number(i.site_id),
      siteName: i.site_name,
    })),
  };
}

/**
 * The open problems: one per site, page type and issue kind (see sameProblem in
 * core/issues.ts), each represented by its earliest open issue, with the
 * number of open issues it covers. What an agent investigates: one verdict on
 * the representative settles the rest.
 */
export async function openProblems(db: Database) {
  const rows = await db.query<any[]>(
    `select distinct on (u.site_id, u.type, i.kind)
            i.id, i.kind, i.detail, i.created_at, u.id as url_id, u.url, u.type as url_type,
            s.id as site_id, s.name as site_name, s.scope as site_scope,
            count(*) over (partition by u.site_id, u.type, i.kind) as open
       from issue i
       join url u on u.id = i.url_id
       join site s on s.id = u.site_id
      where i.status = 'open'
      order by u.site_id, u.type, i.kind, i.id`
  );
  return rows.map((r) => ({
    issueId: Number(r.id),
    kind: r.kind,
    detail: r.detail,
    createdAt: r.created_at,
    url: { id: Number(r.url_id), url: r.url, type: r.url_type },
    site: { id: Number(r.site_id), name: r.site_name, scope: r.site_scope ?? null },
    open: Number(r.open),
  }));
}

/** The site's category rows (flat; the UI builds the tree) with product counts. */
export async function siteCategories(db: Database, siteId: number) {
  const rows = await db.query<any[]>(
    `select c.id, c.parent_id, c.name, c.url_id, c.sort_order, u.url,
            (select count(*) from product_category pc where pc.category_id = c.id) as products
       from category c left join url u on u.id = c.url_id
      where c.site_id = ?
      order by c.parent_id nulls first, c.sort_order, c.name`,
    siteId
  );
  return rows.map((c) => ({
    id: Number(c.id),
    parentId: c.parent_id != null ? Number(c.parent_id) : null,
    name: c.name,
    urlId: c.url_id != null ? Number(c.url_id) : null,
    url: c.url ?? null,
    products: Number(c.products),
  }));
}

export interface ProductFilter {
  /** Products in this category or any of its descendants. */
  categoryId?: number;
  q?: string;
  page?: number;
  pageSize?: number;
}

/**
 * A site's catalogue, one row per product: thumbnail, price range and stock
 * across its variants. In a category, products keep the listing's order.
 */
export async function listProducts(db: Database, siteId: number, filter: ProductFilter): Promise<Page<any>> {
  const where = ['p.site_id = ?'];
  const args: unknown[] = [siteId];
  const scope: string[] = [];
  if (filter.categoryId !== undefined) {
    scope.push(`with recursive tree(id) as (
      select id from category where id = ? and site_id = ?
      union select c.id from category c join tree t on c.parent_id = t.id)`);
    where.push('exists (select 1 from product_category pc where pc.product_id = p.id and pc.category_id in (select id from tree))');
    args.unshift(filter.categoryId, siteId);
  }
  if (filter.q) {
    where.push('(p.name ilike ? or p.code ilike ? or b.name ilike ?)');
    args.push(`%${filter.q}%`, `%${filter.q}%`, `%${filter.q}%`);
  }
  const { size, p, offset } = pageParams(filter.page, filter.pageSize ?? 48);
  const from = `from product p left join brand b on b.id = p.brand_id where ${where.join(' and ')}`;
  const order =
    filter.categoryId !== undefined
      ? `(select min(pc.position) from product_category pc where pc.product_id = p.id and pc.category_id = ${Number(filter.categoryId)}), p.name`
      : 'p.name';
  const [count] = await db.query<any[]>(`${scope.join('')} select count(*) as n ${from}`, ...args);
  const rows = await db.query<any[]>(
    `${scope.join('')}
     select p.id, p.code, p.name, p.status, b.name as brand,
            (select u.url from product_image pi join url u on u.id = pi.url_id where pi.product_id = p.id
              order by pi.role <> 'thumbnail', pi.role = 'swatch', pi.position limit 1) as image,
            (select count(*) from product_variant v where v.product_id = p.id) as variants,
            (select min(v.price) from product_variant v where v.product_id = p.id) as min_price,
            (select max(v.price) from product_variant v where v.product_id = p.id) as max_price,
            (select bool_or(v.compare_at_price > v.price) from product_variant v where v.product_id = p.id) as on_sale,
            (select count(*) from product_variant v where v.product_id = p.id and v.availability in ('in_stock', 'limited')) as in_stock
       ${from}
      order by ${order}
      limit ${size} offset ${offset}`,
    ...args
  );
  return {
    total: Number(count.n),
    page: p,
    pageSize: size,
    rows: rows.map((r) => ({
      id: Number(r.id),
      code: r.code,
      name: r.name ?? null,
      status: r.status,
      brand: r.brand ?? null,
      image: r.image ?? null,
      variants: Number(r.variants),
      minPrice: num(r.min_price),
      maxPrice: num(r.max_price),
      onSale: r.on_sale === true,
      inStock: Number(r.in_stock),
    })),
  };
}

export interface LiveCheck {
  httpStatus: number | null;
  finalUrl: string | null;
  error: string | null;
  product: {
    name: string | null;
    code: string | null;
    variants: { code: string; name: string | null; price: number | null; availability: string | null }[];
  } | null;
}

/** Fetches the url live right now and extracts its JSON-LD product data, for drift checks. */
export async function liveProduct(url: string): Promise<LiveCheck> {
  try {
    const response = await request(url, {
      headers: REQUEST_HEADERS,
      redirect: 'follow',
      timeout: 30_000,
      responseType: 'buffer',
    });
    if (response.statusCode !== 200 || !/text|json/i.test(response.contentType)) {
      return { httpStatus: response.statusCode, finalUrl: response.url, error: null, product: null };
    }
    const data = productFromJsonLd(jsonLd(parse(response.text(), { baseUrl: response.url })));
    return {
      httpStatus: response.statusCode,
      finalUrl: response.url,
      error: null,
      product: data
        ? {
            name: data.product.name ?? null,
            code: data.product.code ?? null,
            variants: data.variants.map((v) => ({
              code: v.code ?? '',
              name: v.name ?? null,
              price: v.price ?? null,
              availability: v.availability ?? null,
            })),
          }
        : null,
    };
  } catch (err: any) {
    return { httpStatus: null, finalUrl: null, error: String(err?.message ?? err), product: null };
  }
}
/** One issue with its url/site context and the state of its escalation input. */
export async function issueDetail(db: Database, id: number) {
  const [issue] = await db.query<any[]>(
    `select i.id, i.kind, i.status, i.verdict, i.detail, i.resolution, i.same_as, i.created_at, i.resolved_at,
            (select count(*) from issue c where c.same_as = i.id) as copies,
            u.id as url_id, u.url, u.type as url_type, u.status as url_status,
            s.id as site_id, s.name as site_name, s.scope as site_scope
       from issue i
       join url u on u.id = i.url_id
       join site s on s.id = u.site_id
      where i.id = ?`,
    id
  );
  if (!issue) return null;
  return {
    id: Number(issue.id),
    kind: issue.kind,
    status: issue.status,
    verdict: issue.verdict ?? null,
    detail: issue.detail,
    resolution: issue.resolution ?? null,
    sameAs: num(issue.same_as),
    copies: Number(issue.copies),
    createdAt: issue.created_at,
    resolvedAt: issue.resolved_at,
    urlId: Number(issue.url_id),
    url: issue.url,
    urlType: issue.url_type,
    urlStatus: issue.url_status,
    siteId: Number(issue.site_id),
    siteName: issue.site_name,
    siteScope: issue.site_scope ?? null,
  };
}
