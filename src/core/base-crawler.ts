import { existsSync } from 'fs';
import { mkdir } from 'fs/promises';
import { join } from 'path';
import { parse, XDocument } from 'gumbo-html';
import { CoreDatabase } from './base-database';
import { crawledUrlTypes, domain } from './domain';
import { recordIssue } from './issues';
import { regressions, snapshots, takeSnapshot } from './snapshot';
import { Config, CrawlerOptions, SiteUrl, UrlStatus } from './models';
import { Proxy, ProxyError, ProxyLease, proxies, proxySpec, refusedStatus, releaseLease, viaProxy } from './proxy';
import { PathRules, allowAll, siteRobots } from './robots';
import { sha1, sleep } from './utils';

import { PuppetClient as WebClient, HttpClient, RequestOptions, Response, readPage, DefaultHttpClient } from './fetch';
import { Logger, getSimpleLogger } from './logger';

/**
 * The crawl loop for one site: claims urls, fetches them at the site's pace,
 * saves the responses, hands each page to the handler for its type
 * (`scrape<Type>`, declared by the domain), flushes what the handler recorded
 * and reports what went wrong. A domain extends it with its page handlers and
 * validation; a site crawler extends the domain's class.
 */
export class Crawler<DB extends CoreDatabase = CoreDatabase> {
  db: DB;
  config: Config;
  options: CrawlerOptions;
  client: HttpClient;
  logger: Logger;
  threadId: number;
  /** Set by signal handlers; the run loop finishes its current url and stops. */
  stop: { requested: boolean } = { requested: false };
  /**
   * The site's page fetches that failed in a row, shared by the crawl's threads;
   * `blocked` is set when there are BLOCKED_AFTER of them and the crawl stops.
   */
  refusals: { reasons: string[]; blocked?: string } = { reasons: [] };
  /** The site's proxy, shared by the crawl's threads. */
  proxy: ProxyLease = {};
  /** The proxy generation the client's connections were made on; see `send`. */
  private clientGeneration = 0;
  /** Each host's robots.txt, read with the first request to it. */
  private robots = new Map<string, Promise<Robots>>();
  /** When the last request to the site went out, for pacing the next. */
  private lastRequestAt = 0;
  /** Where the responses a scrape handler fetches are recorded and replayed from; see `fetch`. */
  fetches?: { dir: string };

  response!: Response;
  siteUrl!: SiteUrl;
  doc!: XDocument;

  constructor(db: DB, config: Config) {
    this.db = db;
    this.config = config;
    this.options = this.db.site.crawler;
    if (this.options.usePuppeteer) {
      this.client = new WebClient();
    } else {
      this.client = new DefaultHttpClient();
    }
    this.threadId = 0;
    this.logger = getSimpleLogger();
  }

  async bootstrap() {}

  async cleanup() {
    await this.db.end();
  }

  /** Closes the client (the browser) and releases the site's proxy. */
  async close() {
    await this.client.close();
    await releaseLease(this.proxy);
  }

  /** The site's proxy, started on first use; null when the site is fetched directly. */
  private proxyFor(): Promise<Proxy | null> {
    return (this.proxy.lease ??= (async () => {
      const spec = proxySpec(this.options);
      if (!spec) return null;
      const proxy = await proxies().get(spec);
      this.info(`Fetching through ${proxy.label}`);
      return proxy;
    })());
  }

  /**
   * What a scrape handler fetches besides its page - an API, a sitemap, a
   * variant's options. Plain HTTP, paced like every request to the site, and
   * recorded beside the page's snapshot or fixture: a response recorded there
   * is replayed, so re-scraping the page is repeatable and offline.
   */
  async fetch(url: string, options: FetchOptions = {}): Promise<Response> {
    const path = this.fetches && join(this.fetches.dir, sha1(`${options.method ?? 'GET'} ${url} ${options.body ?? ''}`));
    if (path && existsSync(path)) return readPage(path, url);
    const response = await this.request(url, new DefaultHttpClient(), options);
    if (path) {
      await mkdir(this.fetches!.dir, { recursive: true });
      await response.save(path, { compress: this.options.pageSnapshots !== 'raw' });
    }
    return response;
  }

  /** The url's own page, through the site's client (the browser under usePuppeteer). */
  fetchPage(url: string): Promise<Response> {
    return this.request(url, this.client);
  }

  /** One request to the site, after waiting out the pace the site config and robots.txt ask for. */
  private async request(url: string, client: HttpClient, { method, headers = {}, body }: FetchOptions = {}): Promise<Response> {
    const overridden = new Set(Object.keys(headers).map((name) => name.toLowerCase()));
    const options: RequestOptions = {
      ...(method ? { method } : {}),
      headers: [...REQUEST_HEADERS.filter(([name]) => !overridden.has(name.toLowerCase())), ...Object.entries(headers)],
      ...(body === undefined ? {} : { body }),
      redirect: 'follow',
      retry: {
        retries: this.options.maxRetryCount,
        // the site's data queries (search APIs, GraphQL) are POSTs that only read
        methods: ['GET', 'HEAD', 'POST'],
        delay: ({ attempt, statusCode, error }) => {
          this.warn(`Retry #${attempt} ${url} (${statusCode ?? error})`);
          return 10000 * attempt;
        },
      },
    };

    const robots = await this.robotsFor(url);
    if (robots.unreachable) throw new RobotsError(url, `${robots.url} is unreachable (${robots.unreachable})`);
    if (!robots.allows(url)) throw new RobotsError(url, `${robots.url} disallows it`, true);
    return this.send(url, client, options, robots.delay);
  }

  /**
   * Sends one request at the site's pace. Through a proxy, the retries are
   * viaProxy's rather than yareq's: each failed attempt - a network error or a
   * refusal an exit IP draws - first renews the route (a new exit), or
   * replaces the proxy when it is down.
   */
  private async send(url: string, client: HttpClient, options: RequestOptions, crawlDelay = 0): Promise<Response> {
    const proxy = await this.proxyFor();
    const method = options.method ?? 'GET';
    if (!proxy) {
      await this.pace(crawlDelay);
      this.info(`Requesting ${method} ${url} (direct)`);
      return this.received(url, await client.get(url, options));
    }
    return viaProxy(
      proxy,
      this.options.maxRetryCount,
      async () => {
        if (this.clientGeneration !== proxy.generation) {
          // a browser keeps its connections, and with them the old route
          await this.client.close();
          this.clientGeneration = proxy.generation;
        }
        await this.pace(crawlDelay);
        this.info(`Requesting ${method} ${url} (${proxy.label})`);
        return this.received(url, await client.get(url, { ...options, proxy: proxy.url, retry: undefined }));
      },
      refusedStatus,
      (retry, failure, down) => this.warn(`Retry #${retry} ${url} (${failure}): ${down ? 'replacing' : 'renewing'} ${proxy.label}`)
    );
  }

  private received(url: string, response: Response): Response {
    this.info(`${response.statusCode} ${url} (${response.contentType}, ${response.contentLength} bytes)`);
    return response;
  }

  /** Waits until the site's wait time (and the host's robots.txt Crawl-delay) has passed since the last request. */
  private async pace(crawlDelay: number) {
    let seconds = this.options.waitTime ?? 0;
    if (seconds > 0 && this.options.randomWait > 0) seconds += Math.random() * this.options.randomWait;
    seconds = Math.max(seconds, crawlDelay);
    const wait = this.lastRequestAt + seconds * 1000 - Date.now();
    if (wait > 0) {
      this.info(`Waiting for ${(wait / 1000).toFixed(1)}s ...`);
      await sleep(wait);
    }
    this.lastRequestAt = Date.now();
  }

  /**
   * Parses the page (links resolve against its final url) and hands it to the
   * handler for the url's type: `scrapeSeed` for the seed, `scrape<Type>` for a
   * type the domain declares. Override for non-HTML responses.
   */
  async scrape(response: Response, url: SiteUrl): Promise<number> {
    this.response = response;
    this.siteUrl = url;
    this.db.baseUrl = response.url;
    this.doc = parse(response.text(), { baseUrl: response.url });
    await this.handler(url.type).call(this, this.doc);
    return UrlStatus.Done;
  }

  /** The handler for a page type; throws for a type the domain does not declare or the crawler does not handle. */
  protected handler(type: string): (doc: XDocument) => Promise<void> {
    if (!crawledUrlTypes().includes(type)) throw new Error(`Unknown url type: ${type}`);
    const name = `scrape${type.charAt(0).toUpperCase()}${type.slice(1)}`;
    const handler = (this as any)[name];
    if (typeof handler !== 'function') throw new Error(`${this.constructor.name} does not scrape ${type} pages`);
    return handler;
  }

  async scrapeSeed(doc: XDocument): Promise<void> {
    throw new Error(`${this.constructor.name} does not scrape seed pages`);
  }

  async saveResponse(response: Response, url: SiteUrl) {
    const store = this.config.store;
    if (/text|json/i.test(response.contentType)) {
      if (store.html && this.options.pageSnapshots !== 'off') {
        const path = join(store.html, url.id + '.' + url.version);
        await mkdir(store.html, { recursive: true });
        await response.save(path, { compress: this.options.pageSnapshots !== 'raw' });
        this.info(`Saved ${path}`);
      }
    } else if (/^image\//i.test(response.contentType) && store.images) {
      // image/jpeg -> jpeg, image/svg+xml -> svg
      const type = response.contentType.split(/[/;+]/)[1].trim().toLowerCase();
      const path = join(store.images, url.id + '.' + type);
      await mkdir(store.images, { recursive: true });
      await response.save(path, { bodyOnly: true });
      this.info(`Saved ${path}`);
    }
  }

  /**
   * After a complete crawl: compares the site's metrics with what its crawler
   * expects (`site.expect`), raising one acceptance issue for the shortfalls.
   * Returns them; never fails the crawl.
   */
  async checkExpectations(): Promise<string[]> {
    const site = this.db.site;
    if (!site.expect) return [];
    const { expectations, metrics } = domain();
    const shortfalls = expectations.shortfalls(site.expect, await metrics(site.id, this.db));
    if (shortfalls.length === 0) {
      this.info("The catalogue meets the crawler's expectations");
      return [];
    }
    this.warn(`The catalogue falls short of the crawler's expectations: ${shortfalls.join('; ')}`);
    await this.raiseSiteIssue('acceptance', shortfalls);
    return shortfalls;
  }

  /**
   * After a complete crawl: records the site's state and compares it with the
   * last complete crawl's, raising one regression issue for what got worse.
   * Returns the regressions; never fails the crawl.
   */
  async checkRegression(): Promise<string[]> {
    const site = this.db.site;
    const [previous] = await snapshots(this.db, site.id, 1);
    const current = await takeSnapshot(this.db, site.id);
    const found = previous ? regressions(previous, current) : [];
    if (found.length) {
      this.warn(`The crawl came out worse than the last complete one: ${found.join('; ')}`);
      await this.raiseSiteIssue('regression', found);
    }
    return found;
  }

  /**
   * Counts a page fetch towards the site refusing the crawl: a failed one adds to
   * the run, any other ends it. At BLOCKED_AFTER failures in a row the crawl
   * stops and one blocked issue is raised, rather than failing every url left.
   */
  private async countRefusal(url: string, failure: string | null) {
    const refusals = this.refusals;
    if (failure === null) {
      refusals.reasons = [];
      return;
    }
    refusals.reasons.push(failure);
    if (refusals.blocked || refusals.reasons.length < BLOCKED_AFTER) return;
    const counts = new Map<string, number>();
    for (const reason of refusals.reasons) counts.set(reason, (counts.get(reason) ?? 0) + 1);
    const tally = [...counts]
      .sort((a, b) => b[1] - a[1])
      .map(([reason, n]) => `${n} × ${reason}`)
      .join(', ');
    refusals.blocked =
      `the last ${refusals.reasons.length} page fetches failed (${tally}), the latest ${url}; ` +
      `the crawl stopped rather than fail the urls left`;
    this.stop.requested = true;
    this.error(`Blocked: ${refusals.blocked}`);
    await this.raiseSiteIssue('blocked', [refusals.blocked]);
  }

  /** Raises a site-wide issue, filed against the site's entry page. */
  private async raiseSiteIssue(kind: 'acceptance' | 'regression' | 'blocked', findings: string[]) {
    const [anchor] = await this.db.query<{ id: number; url: string }[]>(
      `select id, url from url where site_id = ? order by (type = 'seed') desc, id limit 1`,
      this.db.site.id
    );
    if (!anchor) return;
    try {
      await recordIssue(this.db, anchor, kind, findings.join('; '));
    } catch (err: any) {
      this.warn(`Could not record the ${kind}: ${err?.message ?? err}`);
    }
  }

  /** Fetches, saves and (optionally) scrapes one url, then flushes the results. */
  async process(url: SiteUrl, { scrape = true } = {}) {
    this.info(`Processing ${url.url}`);

    const fetchStart = new Date();
    const store = this.config.store?.html;
    this.fetches = store && this.options.pageSnapshots !== 'off' ? { dir: join(store, `${url.id}.${url.version}.fetches`) } : undefined;
    let response: Response;
    try {
      response = await this.fetchPage(url.url);
    } catch (err: any) {
      if (err instanceof ProxyError) throw err;
      if (err instanceof RobotsError && err.disallowed) {
        // recorded like a path-rule exclusion; a recrawl re-checks it against the robots.txt of the day
        this.info(err.message);
        await this.db.table('url').update({ status: UrlStatus.Disallowed }, { id: url.id });
        return;
      }
      this.warn(`Could not fetch ${url.url} ${err}`);
      this.db.table('url').append({
        id: url.id,
        status: UrlStatus.FetchFailed,
        visitTime: fetchStart,
      });
      this.db.table('url_fetch').append({
        url: url.id,
        fetchTime: fetchStart,
        fetchDuration: Date.now() - fetchStart.getTime(),
        error: err.message ?? String(err),
      });
      await this.db.flush();
      this.db.clear();
      await this.countRefusal(url.url, err?.code ?? (err instanceof RobotsError ? 'robots.txt unreachable' : String(err?.message ?? err)));
      return;
    }

    const refused = response.statusCode >= 400 && response.statusCode !== 404 && response.statusCode !== 410;
    await this.countRefusal(url.url, refused ? `HTTP ${response.statusCode}` : null);
    await this.saveResponse(response, url);

    const recordFetch = () => {
      this.db.urlFetch = this.db.table('url_fetch').append({
        url: url.id,
        httpStatus: response.statusCode,
        fetchTime: response.fetchStart,
        fetchDuration: response.fetchDuration,
        finalUrl: response.url,
        contentType: response.contentType,
        contentHash: response.contentMD5,
        contentLength: response.contentLength,
      });
    };
    recordFetch();

    let status: number = UrlStatus.Done;
    let scrapeError: string | null = null;
    const scraped = scrape && response.statusCode === 200 && /text|json/i.test(response.contentType);
    if (response.statusCode !== 200) {
      status = UrlStatus.FetchFailed;
      if (response.statusCode === 404 || response.statusCode === 410) {
        await domain().pageGone?.(url, this.db);
      }
    } else if (scraped) {
      try {
        status = await this.scrape(response, url);
      } catch (err: any) {
        status = UrlStatus.ScrapeFailed;
        scrapeError = err?.message ?? String(err);
        this.error(err.stack || err);
        this.db.clear();
        recordFetch();
      }
    }
    this.info(`Processed ${url.url} (${status})`);

    this.db.table('url').append({
      id: url.id,
      status,
      visitTime: response.fetchStart,
      version: url.version + 1,
      // a scraper may vouch for a page it handled deliberately (e.g. a
      // confirmed-empty collection); persist the note with the status
      ...(url.data ? { data: url.data } : {}),
    });

    this.info(`Flushing (${this.db.stats()})`);
    await this.db.flush();
    this.db.clear();

    if (scraped) {
      await this.report(url, status, scrapeError);
    }
  }

  /**
   * Records a problem with a scraped url as an issue for triage (see
   * src/core/issues.ts): a scrape that threw, or data that fails validation.
   * Never fails the crawl.
   */
  private async report(url: SiteUrl, status: number, scrapeError: string | null) {
    try {
      if (status === UrlStatus.ScrapeFailed) {
        await recordIssue(this.db, url, 'scrape_failed', scrapeError ?? 'scrape failed');
      } else if (status === UrlStatus.Done && !url.data) {
        // The scraper examined this page and recorded what it found - a confirmed
        // empty collection, a CMS page whose url shape is indistinguishable from a
        // product's. Trust that over the checks for its type.
        const issues = await this.validate(url);
        if (issues.length > 0) {
          await recordIssue(this.db, url, 'validation', issues.join('; '));
        }
      }
    } catch (err: any) {
      this.warn(`Could not record an issue for ${url.url}: ${err?.message ?? err}`);
    }
  }

  /**
   * Deterministic sanity checks on the data just scraped from a url (no LLM).
   * Returns the problems found; empty means the data looks fine. The domain's
   * crawler class asks the questions for each of its page types; a site crawler
   * overrides to add or relax checks. Only what this page itself can answer
   * belongs here.
   */
  async validate(url: SiteUrl): Promise<string[]> {
    return [];
  }

  /** The page the crawler is holding for `url`, or its saved snapshot; null when neither is at hand. */
  protected async pageOf(url: SiteUrl): Promise<XDocument | null> {
    if (this.siteUrl?.id === url.id && this.doc) return this.doc;
    const dir = this.config.store?.html;
    if (!dir) return null;
    const response = await readPage(join(dir, `${url.id}.${url.version}`)).catch(() => null);
    return response ? parse(response.text()) : null;
  }

  async start(reset?: boolean) {
    this.info(`Started reset=${reset}`);

    if (reset) {
      await this.db.resetUrls({});
      await this.bootstrap();
    }

    const threadCount = this.options.threadCount;
    const promises = [];

    for (let i = 0; i < threadCount; i++) {
      const Constructor: any = this.constructor;
      const crawler = new Constructor(this.db.clone(), this.config);
      crawler.threadId = i + 1;
      crawler.stop = this.stop;
      crawler.refusals = this.refusals;
      crawler.proxy = this.proxy;
      promises.push(crawler.run());
    }

    return Promise.all(promises);
  }

  async run() {
    this.info(`Running`);

    let idleTime = 0;

    while (true) {
      if (this.stop.requested) {
        this.info('Stop requested');
        break;
      }
      const url = await this.db.claimUrl({ type: crawledUrlTypes() });

      if (!url) {
        if (this.stop.requested) break;
        if (idleTime >= 50000) {
          this.info('No more urls');
          break;
        }
        this.info('Waiting for more urls');
        await sleep(10000);
        idleTime += 10000;
        continue;
      }

      idleTime = 0;

      // rules tightened after the url was queued
      if (url.type !== 'seed' && !this.db.allows(url.url)) {
        await this.db.table('url').update({ status: UrlStatus.Disallowed }, { id: url.id });
        this.info(`Disallowed by the path rules: ${url.url}`);
        continue;
      }

      await this.process(url);
      this.info(`Done ${url.url}`);
    }
  }

  /**
   * The robots.txt of `url`'s host, read once per crawl. An unreachable one is
   * read again after a minute, so a passing outage does not stall the crawl.
   */
  private async robotsFor(url: string): Promise<Robots> {
    const { origin } = new URL(url);
    const cached = this.robots.get(origin);
    if (cached) {
      const robots = await cached;
      if (!robots.unreachable || Date.now() - robots.readAt < ROBOTS_RETRY_MS) return robots;
    }
    const reading = this.readRobots(`${origin}/robots.txt`);
    this.robots.set(origin, reading);
    return reading;
  }

  /**
   * RFC 9309: a robots.txt the host does not have (4xx) allows everything; one
   * it cannot serve (5xx, or no answer) allows nothing until it can.
   */
  private async readRobots(robotsUrl: string): Promise<Robots> {
    const readAt = Date.now();
    try {
      const response = await this.send(robotsUrl, new DefaultHttpClient(), { headers: REQUEST_HEADERS, redirect: 'follow' });
      const status = response.statusCode;
      if (status >= 500) return this.unreachableRobots(robotsUrl, `HTTP ${status}`, readAt);
      if (status >= 400) return { url: robotsUrl, delay: 0, allows: allowAll, readAt };
      const userAgent = REQUEST_HEADERS.find(([name]) => name === 'User-Agent')![1];
      const robots = siteRobots(robotsUrl, response.text(), userAgent);
      if (robots.delay) this.info(`${robotsUrl} asks for ${robots.delay}s between requests`);
      return { url: robotsUrl, ...robots, readAt };
    } catch (err: any) {
      if (err instanceof ProxyError) throw err;
      return this.unreachableRobots(robotsUrl, err?.message ?? String(err), readAt);
    }
  }

  private unreachableRobots(robotsUrl: string, reason: string, readAt: number): Robots {
    this.warn(`Could not read ${robotsUrl}: ${reason}; fetching nothing from its host for now`);
    return { url: robotsUrl, delay: 0, allows: () => false, unreachable: reason, readAt };
  }

  info(msg: string) {
    this.logger.info(`[${this.threadId}] ${msg}`);
  }

  warn(msg: string) {
    this.logger.warn(`[${this.threadId}] ${msg}`);
  }

  error(msg: string) {
    this.logger.error(`[${this.threadId}] ${msg}`);
  }
}

/** A scrape handler's request: GET by default; `body` is sent as given (JSON.stringify an object). */
export interface FetchOptions {
  method?: 'GET' | 'POST';
  headers?: { [name: string]: string };
  body?: string;
}

/** Page fetches failing in a row (any error or HTTP status but 404 and 410) that stop a crawl as blocked. */
const BLOCKED_AFTER = 20;

/** How long an unreachable robots.txt stops its host's requests before it is read again. */
const ROBOTS_RETRY_MS = 60_000;

/** A host's robots.txt as a crawl read it. */
interface Robots {
  url: string;
  delay: number;
  allows: PathRules;
  /** Why it could not be read; nothing is fetched from the host meanwhile. */
  unreachable?: string;
  readAt: number;
}

/** A request the host's robots.txt does not allow, or cannot say whether it allows. */
export class RobotsError extends Error {
  constructor(
    readonly url: string,
    reason: string,
    /** The rules disallow the url, rather than being unreadable. */
    readonly disallowed = false
  ) {
    super(`Not fetching ${url}: ${reason}`);
  }
}

export const REQUEST_HEADERS: [string, string][] = [
  ['Accept', 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8'],
  ['Accept-Language', 'en-AU,en;q=0.9'],
  ['Cache-Control', 'no-cache'],
  ['Pragma', 'no-cache'],
  ['Upgrade-Insecure-Requests', '1'],
  ['User-Agent', 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'],
];
