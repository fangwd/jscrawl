// The jscrawl domain tools, served over MCP streamable HTTP (src/mcp/server.ts) to
// agents: fetching pages the way the crawler does, querying saved pages, read-only sql,
// url inspection, probing, scrape previews, and crawl control over the jscrawl HTTP API.

import { mkdir, readdir, readFile, rm, writeFile } from 'fs/promises';
import { parse, XElement } from 'gumbo-html';
import { dirname, join, relative, resolve } from 'path';
import { Database } from 'sqlex';
import { request } from 'yareq';
import { gunzipSync, gzip } from 'zlib';
import { promisify } from 'util';
import { z } from 'zod';
import { REQUEST_HEADERS } from '../core/base-crawler';
import { coverage as buildCoverage, CoverageReport, ShapeGroup, urlPath } from '../core/coverage';
import { closingBracket, embeddedJson, jsonLd } from '../core/extract';
import { sameProblem } from '../core/issues';
import { inspectUrl as buildUrlReport, listSnapshots, URL_STATUS, UrlReport } from '../core/inspect';
import { Config, ProxyType } from '../core/models';
import { parseProxy, Proxy, proxies, ProxySpec, proxySpec, refusedStatus, viaProxy } from '../core/proxy';
import { fetchText } from '../core/sitemap';
import { probePage, ProbeReport } from '../core/pageprobe';
import { scrapePreview, scrapePreviews } from '../core/preview';
import { describeFailure, describeRegistration, populateSites } from '../core/register';
import { readPage } from '../core/fetch';
import { readOnlyQuery, tableColumns } from '../core/sql';
import { crawledUrlTypes, domain } from '../core/domain';
import { getCrawler, sha1 } from '../core/utils';
import { typecheckCrawler } from '../core/typecheck';
import { lintCrawler } from '../core/lint';
import { submitCrawler } from '../core/crawlersRepo';
import { fixtureDir, siteModule, sitesDir } from '../core/sites';
import { FixtureEntry, fixtureContracts, fixturePages } from '../core/fixtures';
import { snapshots } from '../core/snapshot';

const gzipBody = promisify(gzip);

export type ZodRawShape = Record<string, z.ZodTypeAny>;

export interface ToolContext {
  cwd: string;
  signal?: AbortSignal;
}

export interface DomainTool {
  name: string;
  description: string;
  schema: ZodRawShape;
  /** Reads only: advertised as MCP's readOnlyHint, which read-only agent profiles admit. */
  readOnly?: boolean;
  execute(args: any, ctx: ToolContext): Promise<string>;
}

export interface DomainToolDeps {
  db: Database;
  config: Config;
  cwd: string;
  jscrawlUrl: string;
  /** The service token the jscrawl API takes as a bearer (JSCRAWL_API_TOKEN). */
  apiToken?: string;
}

const WEBFETCH_DESCRIPTION =
  'Fetch a URL with the crawler\'s headers (redirects followed, transient failures and 429s retried) and show ' +
  'the status, final URL and content type. format "html" returns the body; "jsonld" returns the structured data ' +
  '(JSON-LD) found on the page; "json" returns a structural summary of a JSON body (keys, array lengths, first ' +
  'item) instead of the raw dump. method, body and headers replay a data call that jscrawl_pageProbe listed. ' +
  'A gzipped body (a .xml.gz sitemap) is unzipped.';

/** Writes a page, dropping the handler responses recorded for its previous content. */
async function savePage(path: string, content: string | Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
  await rm(`${path}.fetches`, { recursive: true, force: true });
}

const SITE_PROXY_PARAM = z
  .string()
  .optional()
  .describe(
    'The site crawler name (crawlers/<site>.ts) whose proxy to fetch through, for a crawler not registered yet; ' +
      "a registered site's url uses its site's proxy without it"
  );

/**
 * The proxy a tool's request goes through: the named crawler's (registered, or
 * as its module declares while it is being built), else that of the registered
 * site whose seed is on the url's host; null when it is fetched directly.
 */
async function toolProxy(
  db: Database,
  config: Config,
  { site, url, registered = false }: { site?: string; url?: string; registered?: boolean }
): Promise<Proxy | null> {
  const spec = await toolProxySpec(db, config, site, url, registered);
  return spec && proxies().get(spec);
}

async function toolProxySpec(db: Database, config: Config, site?: string, url?: string, registered = false): Promise<ProxySpec | null> {
  const rows = await db.query<{ id: number; name: string; seed: string | null; proxy_type: ProxyType | null; proxy_country: string | null }[]>(
    `select s.id, s.name, u.url as seed, c.proxy_type, c.proxy_country
       from site s join crawler c on c.id = s.crawler_id
       left join url u on u.site_id = s.id and u.type = 'seed'`
  );
  const settings = (row: (typeof rows)[number]) => proxySpec({ proxyType: row.proxy_type, proxyCountry: row.proxy_country });
  if (site !== undefined) {
    const row = rows.find((r) => r.name === site || String(r.id) === site);
    if (row) return settings(row);
    return registered ? null : parseProxy(`crawlers/${site}.ts`, siteModule(site, config).site?.proxy);
  }
  const host = url && URL.canParse(url) ? new URL(url).host : null;
  const row = host ? rows.find((r) => r.seed && URL.canParse(r.seed) && new URL(r.seed).host === host) : undefined;
  return row ? settings(row) : null;
}

/** The restricted variant has no saveTo at all: unattended triage must not write files. */
function makeWebfetch(readonly: boolean, db: Database, config: Config): DomainTool {
  return {
    name: readonly ? 'webfetch_readonly' : 'webfetch',
    readOnly: readonly,
    description: readonly
      ? `${WEBFETCH_DESCRIPTION} This variant cannot save files.`
      : `${WEBFETCH_DESCRIPTION} saveTo writes the raw body to a file and reports its gzip size for crawl storage estimates. Save successful JSON ` +
        'once, then inspect its fields offline with jscrawl_json instead of repeatedly fetching it.',
    schema: {
      url: z.string().describe('The URL to fetch'),
      method: z.enum(['GET', 'POST']).optional().describe('"GET" (default) or "POST"'),
      body: z.string().optional().describe('Request body for POST, sent as JSON when it parses as JSON'),
      headers: z.record(z.string(), z.string()).optional().describe(
        'Request headers to add or override, e.g. {"x-requested-with": "XMLHttpRequest"} - the headers jscrawl_pageProbe listed for the call'
      ),
      format: z.enum(['html', 'jsonld', 'json']).optional().describe('"html" (default), "jsonld" or "json"'),
      site: SITE_PROXY_PARAM,
      ...(readonly ? {} : { saveTo: z.string().optional().describe('Path to save the raw body to') }),
    },
    async execute({ url, method = 'GET', body: requestBody, headers = {}, format = 'html', site, saveTo }, ctx) {
      if (readonly && saveTo !== undefined) throw new Error('Unattended triage cannot save files');
      if (format !== 'html' && format !== 'jsonld' && format !== 'json') {
        throw new Error('format must be "html", "jsonld" or "json"');
      }
      const overridden = new Set(Object.keys(headers).map((name) => name.toLowerCase()));
      const proxy = await toolProxy(db, config, { site, url });
      const send = (route?: string) =>
        request(url, {
          method,
          headers: [
            ...REQUEST_HEADERS.filter(([name]) => !overridden.has(name.toLowerCase())),
            ...(Object.entries(headers) as [string, string][]),
          ],
          ...(requestBody === undefined ? {} : requestPayload(requestBody)),
          redirect: 'follow',
          timeout: 30_000,
          signal: AbortSignal.any([AbortSignal.timeout(30_000), ...(ctx.signal ? [ctx.signal] : [])]),
          responseType: 'buffer',
          ...(route ? { proxy: route } : { retry: { retries: 3, delay: ({ attempt }: { attempt: number }) => 3000 * attempt } }),
        });
      const response = proxy ? await viaProxy(proxy, 3, () => send(proxy.url), refusedStatus) : await send();
      const raw = response.body as Buffer;
      // gzip's magic number: a .gz file the server did not mark as content-encoded
      const zipped = raw[0] === 0x1f && raw[1] === 0x8b;
      const content = zipped ? gunzipSync(raw) : raw;
      const text = content.toString('utf8');
      const head = `HTTP ${response.statusCode} ${method} ${response.url}\ncontent-type: ${response.contentType}` +
        (zipped ? ' (gzipped; unzipped below)' : '') +
        (proxy ? `\nvia ${proxy.label}` : '');
      let saved = '';
      if (saveTo) {
        const path = resolve(ctx.cwd, saveTo);
        await savePage(path, content);
        saved = `\nsaved ${content.length} bytes to ${path}`;
        if (zipped || /text|json/i.test(response.contentType)) {
          saved += `\ngzip snapshot estimate: ${(await gzipBody(content)).length} bytes/page (body only)`;
        }
      }
      const body =
        format === 'jsonld'
          ? JSON.stringify(jsonLd(parse(text, { baseUrl: response.url })), null, 2)
          : format === 'json'
            ? summarizeJson(text)
            : text;
      return `${head}${saved}\n\n${body}`;
    },
  };
}

/** A JSON body goes out as JSON (with its content type); anything else as is. */
function requestPayload(body: string): { json: unknown } | { body: string } {
  try {
    return { json: JSON.parse(body) };
  } catch {
    return { body };
  }
}

/** A structural summary of a JSON body: shape and previews, not the whole dump. */
function summarizeJson(text: string): string {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (err) {
    return `(not valid JSON: ${String(err).slice(0, 80)})\n${text.slice(0, 2000)}`;
  }
  const describe = (v: unknown, depth: number): string => {
    if (Array.isArray(v)) {
      return `array[${v.length}]${v.length ? ` first: ${describe(v[0], depth + 1)}` : ''}`;
    }
    if (v && typeof v === 'object') {
      const entries = Object.entries(v as Record<string, unknown>);
      if (depth >= 2) return `{${entries.map(([key]) => key).join(', ').slice(0, 200)}}`;
      return `{ ${entries.map(([key, val]) => `${key}: ${describe(val, depth + 1)}`).join(', ').slice(0, 1500)} }`;
    }
    return (JSON.stringify(v) ?? String(v)).slice(0, 60);
  };
  return describe(value, 0).slice(0, 4000);
}

const html: DomainTool = {
  name: 'html',
  readOnly: true,
  description:
    'Query a saved HTML page or raw/gzip response snapshot, parsed the way the crawler parses it. With a selector: list each match as its ' +
    'normalized text, the value of one attribute (attr), or the start of its HTML (output "html"). ' +
    'With output "scripts": inventory the inline scripts (id, type, size, whether the content or an assigned ' +
    'value parses as JSON, top-level keys). With json: extract an embedded JSON blob - a script id ("#id"), an ' +
    'inventory index ("[3]", numbered as output "scripts" lists them) or an assignment marker ("window.X =") - ' +
    'optionally narrowed by a dotted path ("products.0.title"). With search: each place the raw page contains that ' +
    'text (case-insensitive), with the markup around it - where a value lives, which classes a section uses. ' +
    'Use this rather than reading, grepping or regex-searching saved pages.',
  schema: {
    file: z.string().describe('Path to the saved page'),
    selector: z.string().optional().describe('CSS selector, e.g. ".product-card a[href]"'),
    attr: z.string().optional().describe('Show this attribute instead of the text'),
    output: z.enum(['text', 'html', 'scripts']).optional().describe('"text" (default), "html" or "scripts"'),
    json: z.string().optional().describe('Embedded JSON to extract: "#script-id", an inventory index like "[3]" (the numbering of output "scripts"), or an assignment marker like "window.X ="'),
    path: z.string().optional().describe('Dotted path into the extracted JSON, e.g. "products.0.title"'),
    search: z.string().optional().describe('Text to find in the raw page, e.g. "ratingValue" or "product-feature"'),
    limit: z.number().int().optional().describe('Matches to show (default 20)'),
  },
  async execute({ file, selector, attr, output = 'text', json, path, search, limit = 20 }, ctx) {
    const response = await readPage(resolve(ctx.cwd, file));
    if (search !== undefined) return searchPage(response.text(), search, limit);
    const doc = parse(response.text(), { baseUrl: response.url });
    if (json !== undefined) {
      const value = extractJson(doc, json);
      if (value === undefined) throw new Error(`No JSON found for "${json}" in ${file}`);
      return JSON.stringify(navigate(value, path), null, 1);
    }
    if (output === 'scripts') return scriptInventory(doc, limit);
    if (!selector) throw new Error('selector is required unless json is given');
    const matches = doc.find(selector);
    const shown = matches.slice(0, limit).map((el, i) => {
      const value = attr ? el.attr(attr) ?? '(no attribute)' : output === 'html' ? el.outerHTML.slice(0, 2000) : el.text({ normalize: true }).slice(0, 500);
      return `[${i + 1}] ${value}`;
    });
    return [`${matches.length} matches for ${selector}`, ...shown].join('\n');
  },
};

/** Each place `text` occurs in a raw page, with the markup around it. */
function searchPage(page: string, text: string, limit: number): string {
  const haystack = page.toLowerCase();
  const needle = text.toLowerCase();
  if (!needle) throw new Error('search needs some text');
  const shown: string[] = [];
  let count = 0;
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + needle.length)) {
    if (++count <= limit) {
      const context = page.slice(Math.max(0, at - 150), at + needle.length + 150).replace(/\s+/g, ' ');
      shown.push(`[${count}] …${context}…`);
    }
  }
  return [`${count} matches for "${text}"`, ...shown].join('\n');
}

/** The JSON behind "#script-id", an inventory index ("[3]") or an assignment marker, parsed from a saved page. */
function extractJson(doc: ReturnType<typeof parse>, spec: string): unknown {
  const index = /^\[(\d+)]$/.exec(spec);
  if (index) {
    const script = inlineScripts(doc)[Number(index[1]) - 1];
    return script === undefined ? undefined : scriptJsonValue(script);
  }
  if (spec.startsWith('#')) {
    const script = doc.first(`script${spec}`);
    if (!script) return undefined;
    return parseJsonChunk(script.textContent ?? '');
  }
  return embeddedJson(doc, spec);
}

/** The inline scripts of a page, in the order output "scripts" numbers them. */
function inlineScripts(doc: ReturnType<typeof parse>): XElement[] {
  return doc.find('script').filter((s) => !s.attr('src'));
}

/** The JSON an inline script carries: its whole body, or the value of a window.X = {...} assignment. */
function scriptJsonValue(script: XElement): unknown {
  const text = script.textContent ?? '';
  const trimmed = text.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return parseJsonChunk(trimmed);
  const assign = /(?:window|globalThis)\.[A-Za-z_$][\w.$]*\s*=\s*[{[]/.exec(text);
  return assign ? parseJsonChunk(trimmed.slice(trimmed.indexOf(assign[0]) + assign[0].length - 1)) : undefined;
}

function parseJsonChunk(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      // fall through to bracket matching
    }
  }
  const start = trimmed.search(/[{[]/);
  if (start === -1) return undefined;
  const end = closingBracket(trimmed, start);
  if (end === -1) return undefined;
  try {
    return JSON.parse(trimmed.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

function navigate(value: unknown, path?: string): unknown {
  if (!path) return value;
  let current = value;
  for (const segment of path.split('.')) {
    if (current === null || current === undefined) return undefined;
    if (typeof current !== 'object' || !Object.hasOwn(current, segment)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

const json: DomainTool = {
  name: 'json',
  readOnly: true,
  description:
    'Inspect a saved JSON response without fetching it again. With no path, return a structural summary. ' +
    'With a dotted path (e.g. "options.0", "variants.0", "images.0"), return that exact JSON value so you can ' +
    'check strings versus objects, units and optional fields before writing extraction code.',
  schema: {
    file: z.string().describe('Path to a JSON file saved by jscrawl_webfetch saveTo'),
    path: z.string().min(1).optional().describe('Dotted field/index path; omit for a structural summary'),
  },
  async execute({ file, path }, ctx) {
    ctx.signal?.throwIfAborted();
    const text = await readFile(resolve(ctx.cwd, file), 'utf8');
    const value = JSON.parse(text);
    if (path === undefined) return summarizeJson(text);
    const selected = navigate(value, path);
    if (selected === undefined) throw new Error(`No JSON value at "${path}" in ${file}`);
    return JSON.stringify(selected, null, 1);
  },
};

/** What an engineer sees in devtools' script inspector: id, type, size, JSON-ness, keys. */
function scriptInventory(doc: ReturnType<typeof parse>, limit: number): string {
  const scripts = inlineScripts(doc);
  const lines = scripts.slice(0, limit).map((s, i) => {
    const text = s.textContent ?? '';
    const trimmed = text.trim();
    const value = scriptJsonValue(s);
    const keys =
      value && typeof value === 'object' && !Array.isArray(value)
        ? ` keys: ${Object.keys(value).slice(0, 8).join(', ')}`
        : Array.isArray(value)
          ? ` array[${value.length}]`
          : '';
    return (
      `[${i + 1}] id=${s.attr('id') ?? '-'} type=${s.attr('type') ?? '-'} ${Math.round(text.length / 1024)}KB ` +
      `${value !== undefined ? '(json)' : '(js)'}${keys} ${trimmed.slice(0, 100).replace(/\s+/g, ' ')}`
    );
  });
  return [`${scripts.length} inline scripts`, ...lines].join('\n');
}

const MAX_ROWS = 200;

function sql(db: Database): DomainTool {
  return {
    name: 'sql',
    readOnly: true,
    description:
      'Run one read-only SELECT query (PostgreSQL; WITH queries supported) against the crawler database: crawl state in url and url_fetch, ' +
      `scraped data in product, product_variant, variant_price, product_attribute(_value), category and so on. ` +
      `Returns up to ${MAX_ROWS} rows, one JSON object per line. Writes are rejected.`,
    schema: {
      query: z.string().describe('The SQL query'),
    },
    async execute({ query }, ctx) {
      ctx.signal?.throwIfAborted();
      const { rows, truncated } = await readOnlyQuery(db, query, { maxRows: MAX_ROWS, signal: ctx.signal });
      return [
        ...rows.map((row) => JSON.stringify(row)),
        truncated ? `(More than ${MAX_ROWS} rows; showing ${MAX_ROWS}. Add a limit or aggregate.)` : `(${rows.length} rows)`,
      ].join('\n');
    },
  };
}

/**
 * One read-only call that bundles everything the crawler knows about a page.
 * A thin wrapper over the shared UrlReport (src/core/inspect.ts, also served
 * as JSON by the web API), rendered here as text for the model.
 */
function inspectUrl(db: Database, config: Config): DomainTool {
  return {
    name: 'inspectUrl',
    readOnly: true,
    description:
      'What the crawl knows about one page, in a single read-only call: the url row and its status, the site, ' +
      'the latest fetch (http status / error), the page snapshot policy (gzip/raw/off), saved snapshot path(s), and ' +
      `the urls it queued. What the page produced is jscrawl_${domain().inspectTool}'s. Accepts the page url or its ` +
      'numeric url id. Use this first when verifying what was scraped from a url.',
    schema: {
      url: z.string().describe('The page url, or its numeric url id'),
    },
    async execute({ url: target }, ctx) {
      ctx.signal?.throwIfAborted();
      return urlReportText(db, config, target, ctx);
    },
  };
}

/** The inspectUrl view of one url: its UrlReport, saved snapshots and snapshot policy. */
async function urlReportText(db: Database, config: Config, target: string, ctx: ToolContext): Promise<string> {
  const report = await buildUrlReport(db, target, ctx.signal);
  if (!report) return `No url row found for "${target}".`;
  const storeDir = config.store?.html;
  const snapshots: string[] = [];
  for (const name of storeDir ? await listSnapshots(resolve(ctx.cwd, storeDir), report.url.id) : []) {
    const fetches = await readdir(resolve(ctx.cwd, storeDir!, `${name}.fetches`)).catch(() => []);
    snapshots.push(join(storeDir!, name) + (fetches.length ? ` (+${fetches.length} fetched by its scrape, replayed on re-scrape)` : ''));
  }
  const storage = !storeDir ? 'off (no HTML store configured)' : report.url.pageSnapshots;
  return renderUrlReport(report, snapshots) + `\npage snapshots: ${storage}` +
    (storage.startsWith('off') ? '\nNew page bodies are not retained; use live fetches or explicit fixtures. Historical comparisons require an existing snapshot.' : '');
}

/** The tool's text view of a UrlReport. */
function renderUrlReport(report: UrlReport, snapshots: string[]): string {
  const { url: u, lastFetch: f } = report;
  const lines: string[] = [];
  lines.push(`url ${u.url}`);
  lines.push(
    `  id=${u.id} site=${u.siteName} type=${u.type} status=${u.status} (${URL_STATUS[u.status] ?? '?'}) ` +
      `version=${u.version} currency=${u.currency ?? '-'} locale=${u.locale ?? '-'} visited=${u.visitTime ?? '-'}`
  );
  lines.push(
    f
      ? `latest fetch: HTTP ${f.httpStatus ?? '-'} ${f.finalUrl ?? ''} (${f.contentType ?? '?'}, ${f.contentLength ?? 0} bytes)` +
          (f.error ? `\n  error: ${f.error}` : '')
      : 'latest fetch: (none recorded)'
  );
      lines.push(`saved snapshots: ${snapshots.length ? snapshots.join(', ') : '(none found)'}`);
      if (report.queued.length) {
        lines.push(`urls enqueued from this page: ${report.queued.length}`);
        for (const q of report.queued.slice(0, 10)) lines.push(`      - [${q.type}] ${q.url}`);
        if (report.queued.length > 10) lines.push(`      ... ${report.queued.length - 10} more`);
      }
      lines.push(`what the page produced: jscrawl_${domain().inspectTool} shows it`);
  return lines.join('\n');
}

/**
 * A headless devtools session as a tool: network JSON, embedded state scripts,
 * framework hints and JSON-LD, so extraction targets the right source. The
 * read-only variant has no saveTo: unattended triage must not write files.
 */
function makePageProbe(readonly: boolean, db: Database, config: Config): DomainTool {
  return {
    name: readonly ? 'pageProbe_readonly' : 'pageProbe',
    readOnly: readonly,
    description:
      'Load a url in a headless browser and report what devtools would show: the data the page fetched over the ' +
      'network (JSON, and the html or text fragments its scripts load), with method, request body and the page\'s ' +
      'own request headers; inline scripts carrying embedded state (window.X = {...}, pure-JSON scripts); ' +
      'framework hints (next/nuxt/angular/vue/react/shopify/wordpress/...); JSON-LD types; and raw vs rendered ' +
      'page size. Use it before choosing selectors: the data may live in an API call or a state blob rather than ' +
      'the DOM. Network calls are ranked by how many of the page\'s visible text lines they contain: the top one ' +
      'usually carries the products and categories. Replay it with jscrawl_webfetch (same method, body and ' +
      'headers) to confirm it works without a browser. interact picks another value in each option picker and ' +
      'lists what that fetched - how a theme loads the variants it does not render.' +
      (readonly ? '' : ' saveTo writes the rendered html, a fixture for a site that only renders in a browser.'),
    schema: {
      url: z.string().describe('The page url to probe'),
      interact: z.boolean().optional().describe('Change each option picker (selects, radio swatches) and report what it fetches'),
      site: SITE_PROXY_PARAM,
      ...(readonly ? {} : { saveTo: z.string().optional().describe('Path to save the rendered html to') }),
    },
    async execute({ url, interact = false, site, saveTo }, ctx) {
      ctx.signal?.throwIfAborted();
      if (readonly && saveTo !== undefined) throw new Error('Unattended triage cannot save files');
      const proxy = await toolProxy(db, config, { site, url });
      const report = proxy
        ? await viaProxy(proxy, 2, () => probePage(url, { interact, proxy: proxy.url }))
        : await probePage(url, { interact });
      let saved = '';
      if (saveTo) {
        const path = resolve(ctx.cwd, saveTo);
        await savePage(path, report.rendered);
        saved = `\nsaved the rendered html (${report.rendered.length} bytes) to ${path}`;
      }
      return renderProbe(report) + saved;
    },
  };
}

/** Network entries as probe lines; with `all`, details even for calls that carry no page text. */
function renderNetwork(entries: ProbeReport['network'], pageTexts: number, all: boolean): string[] {
  const lines: string[] = [];
  entries.forEach((n, i) => {
    const kind = /json/i.test(n.contentType) ? '' : ` ${n.contentType.split(';')[0]}`;
    lines.push(`  [${i + 1}] ${n.method} ${n.url.slice(0, 300)} -> HTTP ${n.status}${kind} ${Math.round(n.bytes / 1024)} KB, ${n.pageTextHits}/${pageTexts} page texts`);
    if (!n.pageTextHits && !all) return;
    if (n.requestBody) lines.push(`      body: ${n.requestBody.slice(0, 1000)}`);
    if (Object.keys(n.requestHeaders).length) lines.push(`      headers: ${JSON.stringify(n.requestHeaders).slice(0, 500)}`);
    if (n.pageTextPaths.length) lines.push(`      page texts at: ${n.pageTextPaths.join(', ')}`);
    lines.push(`      ${(kind ? n.body.replace(/\s+/g, ' ') : summarizeJson(n.body)).slice(0, 600)}`);
  });
  return lines;
}

function renderProbe(r: ProbeReport): string {
  const d = r.document;
  const lines: string[] = [];
  lines.push(
    `document: HTTP ${d.status} ${d.finalUrl} (${d.contentType}) raw ${d.rawBytes} B / rendered ${d.renderedBytes} B`
  );
  lines.push(`title: ${d.title || '(none)'}`);
  lines.push(`framework: ${r.framework.length ? r.framework.join(', ') : '(none detected)'}`);
  lines.push(`json-ld types: ${r.jsonLdTypes.length ? r.jsonLdTypes.join(', ') : '(none)'}`);
  lines.push(`embedded state scripts: ${r.embeddedScripts.length ? '' : '(none)'}`);
  r.embeddedScripts.forEach((s, i) => {
    lines.push(
      `  [${i + 1}] ${s.marker} ${s.parses ? '(parses as JSON)' : '(not pure JSON)'} ${Math.round(s.bytes / 1024)} KB, ` +
        `${s.pageTextHits}/${d.pageTexts} page texts`
    );
    lines.push(`      ${s.preview.replace(/\s+/g, ' ')}`);
  });
  lines.push(`network data responses: ${r.network.length ? '(confirm statically with jscrawl_webfetch)' : '(none)'}`);
  lines.push(...renderNetwork(r.network, d.pageTexts, false));
  if (r.interactions) {
    const { pickers, network } = r.interactions;
    lines.push(
      pickers.length
        ? `after choosing ${pickers.join(', ')}: ${network.length ? '' : 'nothing fetched - the page holds every combination, or loads them another way'}`
        : 'no option pickers (select or radio) to choose from'
    );
    lines.push(...renderNetwork(network, d.pageTexts, true));
  }
  lines.push(
    'Prefer the cheapest source that carries the data: static JSON endpoint > embedded state > JSON-LD > server-rendered DOM > rendered DOM (usePuppeteer).'
  );
  return lines.join('\n');
}

/**
 * The --scrape-file flow as a tool: run a site crawler on a saved page and get
 * the records it would save, by table, without writing anything.
 */
function scrapePreviewTool(config: Config): DomainTool {
  return {
    name: 'scrapePreview',
    readOnly: true,
    description:
      'Run a site crawler on one saved page and return the records it would save, by table, with a count and up ' +
      'to `limit` records each (nothing is written). This is what `npm run jscrawl -- --scrape-file` prints; ' +
      'prefer this tool over running that command through bash. For several pages use jscrawl_dryRun. After ' +
      'every change to a crawler, re-run it to see the effect.',
    schema: {
      site: z.string().describe('The site crawler name (crawlers/<site>.ts)'),
      type: z.string().describe(`Page type: ${crawledUrlTypes().join(', ')}`),
      file: z.string().describe('Path to the saved page'),
      url: z.string().optional().describe('The url the saved page was fetched from'),
      limit: z.number().int().optional().describe('Records per table (default 30)'),
    },
    async execute({ site, type, file, url, limit = 30 }, ctx) {
      ctx.signal?.throwIfAborted();
      const preview = await scrapePreview(config, site, type, resolve(ctx.cwd, file), url, limit);
      return JSON.stringify(preview, null, 1);
    },
  };
}

/**
 * A whole fixture set in one call: every page is scraped with a stand-in site,
 * records are cleared between pages, and a failing page does not hide the rest.
 * This is the supported replacement for the throwaway dry-run scripts agents
 * used to write under /tmp and tmpdry/.
 */
function dryRunTool(config: Config): DomainTool {
  return {
    name: 'dryRun',
    readOnly: true,
    description:
      'Run a site crawler over several saved pages at once and return the records it would save per page, by ' +
      'table, with counts (nothing is written). Each page is independent: a failing fixture reports its error ' +
      'without hiding the others. Use this after every crawler change instead of writing a temporary dry-run ' +
      'script. tables narrows the output to the tables you are checking; limit caps records per table. ' +
      'Optional sections contracts check the full buffer before those output limits. ' +
      'Use jscrawl_validateCrawler for the final typecheck and fixture pass after your last edit.',
    schema: {
      site: z.string().describe('The site crawler name (crawlers/<site>.ts)'),
      pages: z
        .array(z.object({ type: z.string(), file: z.string(), url: z.string().optional() }).passthrough())
        .min(1)
        .describe("Saved pages to run, in order; an entry may carry the domain's fixture contract (pages.json fields)"),
      tables: z.array(z.string()).optional().describe('Only show these tables, e.g. ["product", "product_image"]'),
      limit: z.number().int().optional().describe('Records per table (default 30)'),
    },
    async execute({ site, pages, tables, limit = 30 }, ctx) {
      ctx.signal?.throwIfAborted();
      const results = await scrapePreviews(
        config,
        site,
        pages.map((page: FixtureEntry) => ({ ...page, file: resolve(ctx.cwd, page.file) })),
        limit,
        tables
      );
      return JSON.stringify(results, null, 1);
    },
  };
}

/** A site's crawled catalogue against what its crawler expects (site.expect). */
function checkExpectationsTool(db: Database): DomainTool {
  return {
    name: 'checkExpectations',
    readOnly: true,
    description:
      "Compare a site's crawled catalogue with what its crawler expects (site.expect, in the domain's terms): every " +
      'metric of the catalogue, and every shortfall. The server runs the same check after each complete crawl and ' +
      'raises an acceptance issue for a shortfall. The domain skills say what the metrics and expectations mean.',
    schema: {
      site: z.string().describe('The site name'),
    },
    async execute({ site }, ctx) {
      ctx.signal?.throwIfAborted();
      const [row] = await db.query<{ id: number; expect: any }[]>('select id, expect from site where name = ?', site);
      if (!row) return `No site named "${site}".`;
      const { metrics: measure, metricRules, expectations } = domain();
      const metrics = await measure(Number(row.id), db as any);
      const lines = [`expects: ${row.expect ? JSON.stringify(row.expect) : 'nothing (the crawler sets no site.expect)'}`];
      for (const [name, value] of Object.entries(metrics)) {
        const rule = metricRules[name]?.regression;
        const of = rule?.kind === 'share' ? metrics[rule.of] : undefined;
        const share = of ? ` (${Math.round((100 * value) / of)}%)` : '';
        lines.push(`${metricRules[name]?.label ?? name}: ${value}${share}`);
      }
      const shortfalls = expectations.shortfalls(row.expect, metrics);
      lines.push(shortfalls.length ? `shortfalls:\n${shortfalls.map((s) => `  - ${s}`).join('\n')}` : 'meets its expectations');
      return lines.join('\n');
    },
  };
}

/** The site's state at the end of its recent complete crawls, newest first. */
function crawlHistoryTool(db: Database): DomainTool {
  return {
    name: 'crawlHistory',
    readOnly: true,
    description:
      "A site's state at the end of each of its recent complete crawls, newest first: the domain's metrics, and its " +
      'pages scraped and failed. The server compares each complete crawl with the one before and raises a regression ' +
      "issue when a metric or the failing pages move the wrong way by the margin the domain declares.",
    schema: {
      site: z.string().describe('The site name'),
      limit: z.number().int().min(1).max(50).optional().describe('How many crawls (default 10)'),
    },
    async execute({ site, limit = 10 }, ctx) {
      ctx.signal?.throwIfAborted();
      const [row] = await db.query<{ id: number }[]>('select id from site where name = ?', site);
      if (!row) return `No site named "${site}".`;
      const history = await snapshots(db, Number(row.id), limit);
      if (history.length === 0) return `${site} has not completed a crawl yet.`;
      const { metricRules } = domain();
      return history
        .map((s) => {
          const metrics = Object.entries(s.metrics)
            .map(([name, value]) => `${metricRules[name]?.label ?? name} ${value}`)
            .join(', ');
          return `${new Date(s.takenAt).toISOString()}: ${metrics}; pages ${s.pages.done} scraped, ${s.pages.failed} failed`;
        })
        .join('\n');
    },
  };
}

/**
 * Submits a finished crawler for review: its file and recorded test pages go to
 * a `crawler/<site>` branch and a pull request on the crawlers repository. Prod's
 * crawls pick it up once merged.
 */
function submitCrawlerTool(config: Config): DomainTool {
  return {
    name: 'submitCrawler',
    description:
      'Submit a built or fixed crawler for human review: commits crawlers/<site>.ts and its test pages ' +
      '(crawlers/fixtures/<site>/pages.json, the pages it lists and their recorded fetches) to the branch ' +
      'crawler/<site> on top of the crawlers repository\'s main, pushes it and opens or updates its pull request. ' +
      'Run it last, once jscrawl_checkCrawler passes; resubmitting replaces the branch. Returns the PR url.',
    schema: {
      site: z.string().describe('The site name, as in crawlers/<site>.ts'),
      message: z
        .string()
        .describe('The commit message and PR title on its first line ("koala: new crawler"), then what changed and why'),
    },
    async execute({ site, message }, ctx) {
      ctx.signal?.throwIfAborted();
      fixtureDir(site, config); // validates the name
      const submission = await submitCrawler(sitesDir(config), site, message);
      return [
        `Submitted ${site} on ${submission.branch} (${submission.commit.slice(0, 10)}): ${submission.pr}`,
        ...submission.files.map((file) => `  ${file}`),
      ].join('\n');
    },
  };
}

/**
 * The agent profile's edit hook: validates the crawler an edit changed on the
 * test pages its site records, and fails - an error result - unless it passes.
 * The summary is short, as it follows every crawler edit.
 */
function checkCrawlerTool(config: Config): DomainTool {
  const validate = validateCrawlerTool(config);
  return {
    name: 'checkCrawler',
    readOnly: true,
    description:
      'Check a crawler file as jscrawl_validateCrawler does - typecheck, rule check and a dry run - on the test ' +
      'pages its site records in crawlers/fixtures/<site>/pages.json, file relative to that directory. ' +
      'Every product fixture needs a sections inventory ' +
      '(name, selector, status, evidence; extracted sections need expect saved-field assertions, exceptions need reason). ' +
      'Checks full buffered records even with limit 0. Missing contracts, omissions and unsupported sections fail. ' +
      'Runs by itself after each crawler edit and before a run may finish.',
    schema: {
      file: z.string().describe('The crawler file, crawlers/<site>.ts'),
    },
    async execute({ file }, ctx) {
      const site = /^crawlers\/([\w-]+)\.ts$/.exec(file)?.[1];
      if (!site) throw new Error(`${file} is not a crawler file (crawlers/<site>.ts)`);
      const fixtures = fixtureDir(site, config);
      const listing = relative(ctx.cwd, join(fixtures, 'pages.json'));
      let pages: FixtureEntry[];
      try {
        pages = fixturePages().parse(JSON.parse(await readFile(join(fixtures, 'pages.json'), 'utf8')));
      } catch (err: any) {
        throw new Error(
          `${listing} must list the site's test pages with type, file (relative to its directory) and optional url; product entries need a sections ` +
            `completion contract (see skills/new-site/completeness.md). ` +
            `(${err.code === 'ENOENT' ? 'it does not exist' : String(err.message ?? err).slice(0, 300)})`
        );
      }
      // enough records to see a product page's fields; the summary shows only counts
      const report = JSON.parse(
        await validate.execute({ site, pages: pages.map((page) => ({ ...page, file: join(fixtures, page.file) })), limit: 50 }, ctx)
      );
      const raw = report.typecheck.ok ? siteModule(site, config).site?.expect : undefined;
      const expect = raw === undefined ? undefined : domain().expectations.parse(raw, site);
      let ok = report.ok;
      const lines = [
        ...report.typecheck.diagnostics.slice(0, 10).map((d: any) => `${d.file ?? ''}:${d.line ?? ''} TS${d.code} ${d.message}`),
        ...(report.rules ?? []).map((r: any) => `line ${r.line} [${r.rule}] ${r.message}`),
        ...(report.contracts ?? []).map((problem: string) => `CONTRACT ${problem}`),
        ...report.pages.map((page: any) => {
          const file = relative(ctx.cwd, page.file);
          if (!page.ok) return `FAILED ${file}: ${page.error}`;
          const missing = expect === undefined ? [] : (domain().expectations.pageShortfalls?.(expect, page.tables) ?? []);
          if (missing.length) {
            ok = false;
            return `MISSING ${file}: ${missing.join(', ')} - site.expect requires them on every page of this kind`;
          }
          return `ok ${file}: ${Object.entries(page.tables).map(([table, t]: [string, any]) => `${table} ${t.count}`).join(', ') || 'no records'}${page.check?.summary ? `; ${page.check.summary}` : ''}`;
        }),
      ];
      const summary = `${ok ? 'passed' : 'failed'}: ${site} on ${pages.length} test page(s) from ${listing}\n${lines.join('\n')}`;
      if (!ok) throw new Error(summary);
      return summary;
    },
  };
}

function validateCrawlerTool(config: Config): DomainTool {
  const dryRun = dryRunTool(config);
  return {
    name: 'validateCrawler',
    readOnly: true,
    description:
      'Validate the current crawler after editing: typecheck its source and imports, check it against the new-site ' +
      'skill\'s rules (no page caps, no flush, no slug lists, no /tmp files), then dry-run every supplied fixture ' +
      'without database writes. Compiler errors prevent fixture execution. Returns sourceHash, diagnostics, rule ' +
      'findings, per-page results and an overall ok flag. A later edit invalidates this result. On failure, fix the ' +
      'reported contract and rerun this tool. Product fixtures require a sections inventory with source evidence and ' +
      'saved-field expectations. Unsupported sections, missing values and uninventoried standard tab panels fail. ' +
      'Dry-run success alone is not completeness. On success, run jscrawl_populate.',
    schema: dryRun.schema,
    async execute(args, ctx) {
      ctx.signal?.throwIfAborted();
      const typecheck = typecheckCrawler(config, args.site, ctx.cwd);
      ctx.signal?.throwIfAborted();
      if (!typecheck.ok) {
        return JSON.stringify({
          ok: false, typecheck, pages: [],
          nextStep: 'Fix the compiler diagnostics, then rerun validateCrawler with the same fixtures.',
        }, null, 1);
      }
      const rules = lintCrawler(await readFile(resolve(ctx.cwd, typecheck.file), 'utf8'));
      const parsed = fixturePages().safeParse(args.pages);
      const contracts = parsed.success
        ? fixtureContracts(parsed.data)
        : parsed.error.issues.map((issue) => `pages.${issue.path.join('.')}: ${issue.message}`);
      if (contracts.length) {
        return JSON.stringify({ ok: false, typecheck, rules, contracts, pages: [],
          nextStep: 'Record all product sections and their evidence/expectations in the fixture manifest, then rerun validateCrawler.' }, null, 1);
      }
      const pages = JSON.parse(await dryRun.execute({ ...args, pages: parsed.data }, ctx));
      const ok = rules.length === 0 && pages.every((page: { ok: boolean }) => page.ok);
      return JSON.stringify({
        ok, typecheck, rules, pages,
        nextStep: ok
          ? 'Fixture section contracts passed. Run jscrawl_populate and report extracted sections and justified exceptions. Rerun validation after any edit.'
          : rules.length
            ? 'Fix the rule findings (each names the line and why), then rerun validateCrawler with the same fixtures.'
            : 'Fix the failing extraction using saved evidence, then rerun validateCrawler with the same fixtures.',
      }, null, 1);
    },
  };
}

/**
 * The crawler database schema, so sql queries are written against real column
 * names instead of guessed ones.
 */
function coverageTool(db: Database, config: Config): DomainTool {
  return {
    name: 'coverage',
    readOnly: true,
    description:
      'A read-only coverage and classification audit of one site: the urls its sitemaps list against the urls the ' +
      'crawler queued (the never-queued ones grouped by url shape), queued urls no sitemap lists, and pages whose ' +
      'saved records contradict their url type - a product page that saved no product, a product page that failed, ' +
      'a category that holds no products. Run it after a crawl to find what the url classifier missed or mis-typed; ' +
      'confirm a sample with jscrawl_inspectUrl before drawing a conclusion.',
    schema: {
      site: z.string().describe('The site name or its numeric id'),
    },
    async execute({ site }, ctx) {
      ctx.signal?.throwIfAborted();
      const proxy = await toolProxy(db, config, { site, registered: true });
      const report = await buildCoverage(db, site, { signal: ctx.signal, fetch: (target) => fetchText(target, ctx.signal, proxy) });
      return report ? renderCoverage(report) : `No site named "${site}".`;
    },
  };
}

/** The tool's text view of a CoverageReport: counts, plus a few samples per group. */
function renderCoverage(report: CoverageReport): string {
  const { site, queued, sitemaps } = report;
  const counts = (byType: Record<string, number>) =>
    Object.entries(byType)
      .sort((a, b) => b[1] - a[1])
      .map(([type, count]) => `${type} ${count}`)
      .join(', ');
  const lines = [
    `coverage: ${site.name} (site ${site.id})`,
    ...(site.scope
      ? [
          `scope: ${site.scope} - the crawl keeps to this on purpose, so sitemap urls and products outside it are ` +
            'expected to be never queued, disallowed or vouched',
        ]
      : []),
    `queued ${queued.total} urls: ${counts(queued.byType) || '(none)'} | scraped ${queued.scraped}, ` +
      `failed ${queued.failed}, disallowed ${queued.disallowed}, vouched ${queued.vouched}`,
  ];
  const pending = queued.total - queued.scraped - queued.failed - queued.disallowed;
  if (pending > 0) {
    lines.push(
      `  the crawl is partial (${pending} urls still queued), so "never queued" below means not reached yet as often ` +
        'as it means rejected by the classifier'
    );
  }
  if (sitemaps.files.length === 0) {
    lines.push(
      "sitemaps: none found (no robots.txt Sitemap: line, no /sitemap.xml) - the site's own inventory is unavailable, " +
        'so only the suspects below say anything about coverage'
    );
  } else {
    const matched = sitemaps.urls ? Math.round((100 * sitemaps.matched) / sitemaps.urls) : 0;
    lines.push(
      `sitemaps: ${sitemaps.files.length} files, ${sitemaps.urls} urls -> ${sitemaps.matched} queued (${matched}%), ` +
        `${sitemaps.missing} never queued`
    );
    for (const file of sitemaps.files) {
      lines.push(
        `  ${urlPath(file.url)}: ${file.urls} urls -> ${counts(file.byType) || 'none queued'} | ${file.missing} never queued`
      );
    }
  }
  const shapes = (title: string, groups: ShapeGroup[]) => {
    if (groups.length === 0) return;
    lines.push(title);
    for (const group of groups) {
      lines.push(`  ${group.shape.padEnd(22)} ${String(group.count).padStart(6)}  e.g. ${group.samples.join(', ')}`);
    }
  };
  shapes('listed by the site, never queued - a shape the classifier does not recognise:', report.unqueued);
  shapes('queued, listed by no sitemap:', report.unlisted);
  lines.push('type suspects (candidates; confirm one with jscrawl_inspectUrl before concluding):');
  for (const suspect of report.suspects) {
    lines.push(
      `  ${suspect.label}: ${suspect.count}${suspect.samples.length ? `  e.g. ${suspect.samples.join(', ')}` : ''}`
    );
  }
  return lines.join('\n');
}

/**
 * Register every crawler module with the domain database. Idempotent: it
 * upserts crawler/site rows and queues each optional SEED_URL, so calling it
 * after creating or renaming a crawler keeps the database in step with the
 * crawlers/ repository.
 */
function populateTool({ db, config }: DomainToolDeps): DomainTool {
  return {
    name: 'populate',
    description:
      'Register every crawler under crawlers/ with the domain database: upsert crawler/site rows and queue ' +
      'each module\'s SEED_URL. Idempotent, safe to run repeatedly, and required after creating, renaming or ' +
      'changing a crawler so the site is usable without a human running npm run jscrawl:populate.',
    schema: {},
    async execute(_args, ctx) {
      ctx.signal?.throwIfAborted();
      await db.buildSchema();
      const { registrations, failures } = await populateSites(db, config);
      return [
        ...registrations.map(describeRegistration),
        ...failures.map(describeFailure),
        `Populated ${registrations.length} site(s)${failures.length ? `; ${failures.length} failed` : ''}`,
      ].join('\n');
    },
  };
}

/**
 * The live check of a built crawler: fetch one page, scrape it with the site's
 * crawler and save the records, as a crawl would - then show what was saved.
 */
function scrapeUrlTool(db: Database, config: Config): DomainTool {
  return {
    name: 'scrapeUrl',
    description:
      'Fetch one live page, scrape it with the site\'s crawler and save the records, exactly as a crawl does, then ' +
      'report what was saved (the jscrawl_inspectUrl view). The url is queued with `type` first when it is new, or ' +
      'retyped when it was queued as something else. Writes to the database: use it on a few pages to check a ' +
      'registered crawler live, not as a crawl.',
    schema: {
      site: z.string().describe('The site crawler name (crawlers/<site>.ts), registered with jscrawl_populate'),
      url: z.string().describe('The page url'),
      type: z.string().describe(`Page type: ${crawledUrlTypes().join(', ')}`),
    },
    async execute({ site, url, type }, ctx) {
      ctx.signal?.throwIfAborted();
      const crawler = await getCrawler(config, site);
      try {
        if (type !== 'seed' && !crawler.db.allows(url)) {
          throw new Error(`${url} is excluded by the site's allow/disallow rules`);
        }
        crawler.db.addUrl(url, type, null);
        crawler.db.retypeUrl(url, type);
        await crawler.db.flush();
        crawler.db.clear();
        await crawler.process(await crawler.db.getUrl(url));
      } finally {
        await crawler.db.end();
        await crawler.close();
      }
      return urlReportText(db, config, url, ctx);
    },
  };
}

/** The site export the domain defines, written where asked and summarised. */
function exportFeedTool(db: Database): DomainTool {
  return {
    name: 'exportFeed',
    description:
      "Export a site's saved records as its feed - the file the domain defines for its consumers (see " +
      '/api/docs/feed-format) - and report what it holds and its gaps, plus the first rows. Run it on the pages ' +
      'scraped live when building a crawler to check it end to end. With `file`, also writes the feed there.',
    schema: {
      site: z.string().describe('The site name'),
      file: z.string().optional().describe('A file to write the feed to'),
    },
    async execute({ site, file }, ctx) {
      ctx.signal?.throwIfAborted();
      const [row] = await db.query<{ id: number; name: string }[]>('select id, name from site where name = ?', site);
      if (!row) throw new Error(`No site named "${site}"`);
      const { bytes, summary, sample } = await domain().feed!.export(Number(row.id), db as any);
      const lines = [summary];
      if (file) {
        const path = resolve(ctx.cwd, file);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, bytes);
        lines.push(`written to ${path}`);
      }
      if (sample) lines.push('', sample);
      return lines.join('\n');
    },
  };
}

function dbSchema(db: Database): DomainTool {
  return {
    name: 'dbSchema',
    readOnly: true,
    description:
      'The crawler database schema. Without `table`: every table with its column names. With `table`: that ' +
      'table\'s columns (type, nullability) plus its foreign-key and unique/primary-key constraints. Consult it ' +
      'before writing sql queries.',
    schema: {
      table: z.string().optional().describe('A table name, e.g. "product_variant"'),
    },
    async execute({ table }) {
      const [byTable, constraints] = await Promise.all([
        tableColumns(db),
        db.query<any[]>(
          `select conrelid::regclass::text as table_name, contype, pg_get_constraintdef(oid) as def
             from pg_constraint
            where connamespace = 'public'::regnamespace and contype in ('f', 'p', 'u')
            order by table_name, contype`
        ),
      ]);
      if (!table) {
        return [...byTable.entries()]
          .map(([name, cols]) => `${name}: ${cols.map((c) => c.name).join(', ')}`)
          .join('\n');
      }
      const cols = byTable.get(table);
      if (!cols) throw new Error(`No table "${table}". Tables: ${[...byTable.keys()].join(', ')}`);
      const defs = constraints
        .filter((c) => c.table_name === table)
        .map((c) => `  ${c.contype === 'f' ? 'fk  ' : c.contype === 'p' ? 'pk  ' : 'uniq'} ${c.def}`);
      return [
        `${table}:`,
        ...cols.map((c) => `  ${c.name} ${c.type}${c.nullable ? '' : ' not null'}`),
        ...defs,
      ].join('\n');
    },
  };
}

// expectation_wrong: the crawl is right and the crawler's site.expect does not fit the site
const VERDICTS = ['correct', 'stale', 'extractor_bug', 'fetch_failure', 'not_reproducible', 'expectation_wrong'] as const;
const ISSUE_STATUSES = ['triaged', 'resolved', 'ignored'] as const;

/**
 * The one write the agent tools allow: records the conclusion of investigating
 * a crawl issue and moves it out of "open". Narrow on purpose - it can only set
 * an issue's verdict / resolution / status, never run arbitrary SQL or touch
 * scraped data.
 */
function resolveIssue(db: Database): DomainTool {
  return {
    name: 'resolveIssue',
    description:
      'Record the conclusion of investigating a crawl issue (the `issue` table) and move it out of "open". ' +
      'Sets a verdict, a human-readable resolution (your findings and the PROPOSED fix - do not apply the fix ' +
      'here; a human reviews it), and a status: "triaged" (default) when you propose a change to the crawler, ' +
      'its settings or its expectations - the site is then on hold, no crawl of it starts until a person ' +
      'resolves or ignores the issue; "resolved" when nothing needs changing (data confirmed correct, a ' +
      'transient failure, stale data a re-crawl refreshes, or a fix you were asked to apply now passes); ' +
      '"ignored" (dismissed). Call it once when you finish triaging an issue. This is the only write the agent ' +
      'tools allow.',
    schema: {
      issue: z.number().int().describe('The issue id, from the [jscrawl] escalation message'),
      verdict: z.enum(VERDICTS).describe(`One of: ${VERDICTS.join(', ')}`),
      resolution: z
        .string()
        .describe('Findings, evidence, and the proposed fix (e.g. the change to make in crawlers/<site>.ts). Not applied.'),
      status: z
        .enum(ISSUE_STATUSES)
        .optional()
        .describe('"triaged" (default; a proposed change puts the site on hold), "resolved" (nothing to change) or "ignored"'),
    },
    async execute({ issue, verdict, resolution, status = 'triaged' }, ctx) {
      ctx.signal?.throwIfAborted();
      if (!VERDICTS.includes(verdict)) throw new Error(`verdict must be one of: ${VERDICTS.join(', ')}`);
      if (!ISSUE_STATUSES.includes(status)) throw new Error(`status must be one of: ${ISSUE_STATUSES.join(', ')}`);
      const resolvedAt = status === 'triaged' ? null : new Date();
      const result = await db.transaction(async (connection) => {
        await connection.query("set local statement_timeout = '30s'");
        ctx.signal?.throwIfAborted();
        const rows = await connection.query<{ id: number }[]>(
          `update issue set verdict = ?, resolution = ?, status = ?, resolved_at = ?, same_as = null
             where id = ? and status in ('open', 'triaged')
             returning id`,
          verdict,
          resolution,
          status,
          resolvedAt,
          issue
        );
        if (rows.length === 0) return { rows, twins: [] };
        // every open issue with the same problem, and every unsettled copy of this one, takes this verdict
        const twins = await connection.query<{ id: number }[]>(
          `update issue t set verdict = ?, resolution = null, same_as = i.id, status = ?, resolved_at = ?
             from issue i, url iu, url tu
            where i.id = ? and iu.id = i.url_id and tu.id = t.url_id
              and ((t.status = 'open' and ${sameProblem('t', 'tu', 'i', 'iu')})
                or (t.same_as = i.id and t.status in ('open', 'triaged')))
            returning t.id`,
          verdict,
          status,
          resolvedAt,
          issue
        );
        ctx.signal?.throwIfAborted();
        return { rows, twins };
      });
      if (result.rows.length === 0) throw new Error(`No open or triaged issue ${issue} to update`);
      const twins = result.twins.length ? ` ${result.twins.length} other issue(s) with the same problem got the same verdict.` : '';
      return `Issue ${issue} set to ${status} (${verdict}).${twins}`;
    },
  };
}

/** The jscrawl HTTP API's `{error}` body: what a SupervisorError renders to (src/web/routes.ts fail()). */
class ApiError extends Error {}

/**
 * Crawl control over the jscrawl HTTP API: this server is a child process of the
 * agent, so the Supervisor - and its children - live in the jscrawl server.
 */
function crawlTools({ db, jscrawlUrl, apiToken }: DomainToolDeps): DomainTool[] {
  const call = async (method: 'GET' | 'POST', path: string, body?: unknown, signal?: AbortSignal): Promise<any> => {
    const response = await fetch(`${jscrawlUrl}${path}`, {
      method,
      signal,
      headers: {
        ...(apiToken ? { authorization: `Bearer ${apiToken}` } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    let json: any;
    try {
      json = text === '' ? undefined : JSON.parse(text);
    } catch {
      json = undefined;
    }
    if (!response.ok) {
      if (typeof json?.error === 'string') throw new ApiError(json.error);
      throw new Error(`jscrawl API ${path}: HTTP ${response.status}${text ? ` ${text.slice(0, 200)}` : ''}`);
    }
    if (json === undefined) throw new Error(`jscrawl API ${path} did not return JSON`);
    return json;
  };

  /** API guard errors become tool error text; anything else propagates. */
  const guard = async (fn: () => Promise<unknown>): Promise<string> => {
    try {
      const value = await fn();
      return typeof value === 'string' ? value : JSON.stringify(value);
    } catch (err) {
      if (err instanceof ApiError) return `Error: ${err.message}`;
      throw err;
    }
  };

  const siteArg = z.string().describe('The site name or its numeric id');

  const crawlStatus: DomainTool = {
    name: 'crawlStatus',
    readOnly: true,
    description:
      'The crawl state of every site: whether a crawl is running (pid, run id), the last run status, ' +
      'and the recent crawler_run history of one site when `site` is given. A run is "stopped" when it finished ' +
      'or was asked to stop (Ctrl+C, the stop button, a server shutdown), "blocked" when it stopped itself because ' +
      'the site kept refusing its page fetches (a blocked issue says why), "crashed" only when it failed on its ' +
      'own (read its log with jscrawl_crawlLog), and "interrupted" when the server died before recording it, ' +
      'which says nothing about the crawler.',
    schema: {
      site: z.string().optional().describe('Optional: also list this site\'s recent runs'),
    },
    async execute({ site }, ctx) {
      return guard(async () => {
        const { crawlers } = await call('GET', '/api/crawlers', undefined, ctx.signal);
        if (site === undefined) return { crawlers };
        // the runs route resolves the site (name or id) and 404s with `No site <raw>`
        const { runs } = await call('GET', `/api/crawlers/${encodeURIComponent(site)}/runs`, undefined, ctx.signal);
        const mine = /^\d+$/.test(String(site))
          ? crawlers.filter((c: any) => c.siteId === Number(site))
          : crawlers.filter((c: any) => c.siteName === String(site));
        return { crawlers: mine, runs };
      });
    },
  };

  const crawlStart: DomainTool = {
    name: 'crawlStart',
    description:
      'Start a crawl of a site in the background (one crawl per site; error when one is already running). ' +
      'Only when the user asks for a crawl: building or fixing a crawler never needs one. ' +
      'Returns the crawler_run id; watch progress with jscrawl_crawlStatus and jscrawl_crawlLog.',
    schema: { site: siteArg },
    async execute({ site }, ctx) {
      return guard(async () => {
        const started = await call('POST', `/api/crawlers/${encodeURIComponent(site)}/start`, undefined, ctx.signal);
        return { runId: started.runId };
      });
    },
  };

  const crawlStop: DomainTool = {
    name: 'crawlStop',
    description:
      'Stop a running crawl gracefully: the crawler finishes its current url, flushes and exits. ' +
      'Error when no crawl is running for the site.',
    schema: { site: siteArg },
    async execute({ site }, ctx) {
      return guard(async () => {
        await call('POST', `/api/crawlers/${encodeURIComponent(site)}/stop`, undefined, ctx.signal);
        return { stopped: true };
      });
    },
  };

  const crawlRestart: DomainTool = {
    name: 'crawlRestart',
    description: 'Stop a running crawl gracefully (if any) and start a fresh one. Returns the new crawler_run id.',
    schema: { site: siteArg },
    async execute({ site }, ctx) {
      return guard(async () => {
        const restarted = await call('POST', `/api/crawlers/${encodeURIComponent(site)}/restart`, undefined, ctx.signal);
        return { runId: restarted.runId };
      });
    },
  };

  /** The url the rescrape route wants is numeric; a url string is looked up by its hash. */
  const resolveUrlId = async (target: string): Promise<number> => {
    if (/^\d+$/.test(String(target))) return Number(target);
    const [row] = await db.query<{ id: number }[]>('select id from url where hash = ?', sha1(String(target)));
    if (!row) throw new ApiError(`No url ${target}`);
    return Number(row.id);
  };

  const requeueUrl: DomainTool = {
    name: 'requeueUrl',
    description:
      'Re-scrape one url. mode "queue" (default) idles the url so the next crawl picks it up; ' +
      '"oneshot" scrapes it now in a short-lived child (refused while the site\'s crawl is running).',
    schema: {
      url: z.string().describe('The page url, or its numeric url id'),
      mode: z.enum(['queue', 'oneshot']).optional().describe('"queue" (default) or "oneshot"'),
    },
    async execute({ url, mode = 'queue' }, ctx) {
      if (mode !== 'queue' && mode !== 'oneshot') return 'Error: mode must be queue or oneshot';
      return guard(async () => {
        const id = await resolveUrlId(url);
        return call('POST', `/api/urls/${id}/rescrape`, { mode }, ctx.signal);
      });
    },
  };

  const crawlLog: DomainTool = {
    name: 'crawlLog',
    readOnly: true,
    description: 'The last ~200 lines of a site\'s crawl log (latest run, or the run given).',
    schema: {
      site: siteArg,
      runId: z.number().int().optional().describe('A crawler_run id (default: the site\'s latest run)'),
    },
    async execute({ site, runId }, ctx) {
      return guard(async () => {
        const query = new URLSearchParams({ tail: '1' });
        if (runId !== undefined) query.set('runId', String(runId));
        const tail = await call(
          'GET',
          `/api/crawlers/${encodeURIComponent(site)}/log?${query}`,
          undefined,
          ctx.signal
        );
        return tail.text || '(log is empty)';
      });
    },
  };

  return [crawlStatus, crawlStart, crawlStop, crawlRestart, requeueUrl, crawlLog];
}

function coreTools(deps: DomainToolDeps): DomainTool[] {
  const { db, config } = deps;
  return [
    makeWebfetch(false, db, config),
    makeWebfetch(true, db, config),
    html,
    json,
    sql(db),
    inspectUrl(db, config),
    coverageTool(db, config),
    makePageProbe(false, db, config),
    makePageProbe(true, db, config),
    scrapePreviewTool(config),
    dryRunTool(config),
    validateCrawlerTool(config),
    checkCrawlerTool(config),
    submitCrawlerTool(config),
    checkExpectationsTool(db),
    crawlHistoryTool(db),
    populateTool(deps),
    scrapeUrlTool(db, config),
    ...(domain().feed ? [exportFeedTool(db)] : []),
    dbSchema(db),
    resolveIssue(db),
    ...crawlTools(deps),
  ];
}

/** The core's tools and the domain's, mounted together; a name used by both is a configuration error. */
export function domainTools(deps: DomainToolDeps): DomainTool[] {
  const core = coreTools(deps);
  const app = domain().tools?.(deps) ?? [];
  const names = new Set(core.map((tool) => tool.name));
  for (const tool of app) {
    if (names.has(tool.name)) throw new Error(`The domain's tool "${tool.name}" collides with a core tool`);
  }
  if (!app.some((tool) => tool.name === domain().inspectTool)) {
    throw new Error(`The domain names "${domain().inspectTool}" as its inspect tool but does not provide it`);
  }
  return [...core, ...app];
}
