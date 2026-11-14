import {
  Database,
  DynamicRecord,
  Record,
  ConnectionPool,
  ConnectionInfo,
  Filter,
  Schema,
} from 'sqlex';

import { urlTypes } from './domain';
import { Site, SiteUrl, UrlStatus } from './models';
import { allowAll, pathRules, PathRules } from './robots';
import { sha1 } from './utils';

type Value = string | number | Date | boolean | null;
type FieldMap = { [key: string]: Value | Record };
type UrlFilter = { [key: string]: Value | Value[] };

/**
 * Stores the site's URL queue and buffers each page's records. Domains add
 * tables and typed write methods. Override `init`, `clone`, `flush` and `clear`
 * as needed to carry domain state through the page lifecycle.
 */
export class CoreDatabase extends Database {
  site: Site;
  baseUrl: string;
  hashUrl: (href: string) => string;
  /** The crawler's own path rules: whether a domain url may be queued and fetched. */
  allows: PathRules = allowAll;
  /** The url_fetch row of the page being scraped; observations link to it. */
  urlFetch: Record | null = null;
  /** The run this process is (crawler_run): its claims name it, so they are released when it is over, and so do its fetches. */
  runId: number | null = null;

  /**
   * The type of every url of this site that is already queued, by hash. A link
   * is queued from every page that carries it, and the type is a guess from the
   * url shape, so queueing must not change the type of a url that is already
   * queued: every page links to the menu's categories, and the next one would
   * revert a type a scrape corrected (retypeUrl). Loaded per process and shared
   * with clones.
   */
  protected urlTypes = new Map<string, string>();

  constructor(connection: ConnectionPool | ConnectionInfo, schema?: Schema) {
    super(connection, schema);
    this.site = {} as Site;
    this.baseUrl = '';
    this.hashUrl = sha1;
  }

  async init(name: string): Promise<Site> {
    if (!this.schema) await this.buildSchema();
    this.site = <Site>(
      (<any>await this.table('site').select({ crawler: '*' }, { where: { name } }))[0]
    );
    if (this.site) {
      this.allows = pathRules(this.site.crawler.allow, this.site.crawler.disallow);
      await this.loadUrlTypes();
    }
    return this.site;
  }

  /** The queued urls' types, so a re-queued link cannot revert one. */
  private async loadUrlTypes() {
    this.urlTypes.clear();
    const stored = (await this.table('url').select(
      { hash: true, type: true },
      { where: { site: this.site.id } },
    )) as unknown as {
      hash: string;
      type: string;
    }[];
    for (const url of stored) this.urlTypes.set(url.hash, url.type);
  }

  /** A second handle on the same site for another crawl thread, sharing what the process loaded. */
  clone(): this {
    const db = new (this.constructor as new (connection: ConnectionPool, schema?: Schema) => this)(
      this.pool,
      this.schema,
    );
    db.site = this.site;
    db.hashUrl = this.hashUrl;
    db.urlTypes = this.urlTypes;
    db.allows = this.allows;
    db.runId = this.runId;
    return db;
  }

  async claimUrl(filter?: UrlFilter): Promise<SiteUrl | null> {
    const url: unknown = await this.table('url').claim(
      { site: this.site.id, ...filter, status: UrlStatus.Idle },
      { status: UrlStatus.Busy, claimedAt: new Date(), claimedRun: this.runId },
      ['-priority'],
    );
    return url ? (url as SiteUrl) : null;
  }

  resetUrls(filter?: UrlFilter) {
    return this.table('url').update({ status: 0 }, { site: this.site.id, ...filter });
  }

  /**
   * The absolute, fragment-free form of a url, as it is queued and hashed, or
   * null when it is not a page the crawler could fetch: empty, unparseable, or a
   * scheme like mailto:, tel:, javascript: - or a site's typo'd `ttps://`. Such a
   * link would otherwise sit in the queue as a permanent fetch failure.
   */
  protected absolute(href: string): string | null {
    const cleaned = (href ?? '').replace(/#.*/, '').trim();
    if (!cleaned) return null;
    if (/^https?:\/\//i.test(cleaned)) return cleaned;
    try {
      const resolved = new URL(cleaned, this.baseUrl);
      return /^https?:$/i.test(resolved.protocol) ? resolved.href : null;
    } catch {
      return null;
    }
  }

  /**
   * Queues a page; null when `href` is not a fetchable url (see absolute()). The
   * type must be one the deployment's domain declares. A domain url the
   * crawler's path rules disallow is recorded, so it keeps its place in the
   * site's structure, but never fetched.
   */
  addUrl(data: string | FieldMap, type: string, fromUrlId: number | null): DynamicRecord | null {
    if (type && !urlTypes().includes(type)) {
      throw new Error(`Unknown url type "${type}": this domain queues ${urlTypes().join(', ')}`);
    }
    const href = this.absolute(typeof data === 'string' ? data : <string>data.url);
    if (!href) return null;
    const hash = this.hashUrl(href);
    const url = this.table('url').append({
      url: href,
      site: this.site.id,
      hash,
    });
    if (typeof data !== 'string') {
      for (const key in data) {
        if (key !== 'url') url[key] = data[key];
      }
    }
    // First type wins; retypeUrl is how a type is corrected. A known url still
    // carries its type: the row is inserted first (type is NOT NULL), and an
    // unchanged type is not written over the stored one.
    if (type && !this.urlTypes.has(hash)) this.urlTypes.set(hash, type);
    const known = this.urlTypes.get(hash);
    if (known) url.type = known;
    if (this.isDomainType(type) && !this.allows(href)) {
      url.status = UrlStatus.Disallowed;
    }
    if (fromUrlId) {
      this.table('url_graph').append({ src: fromUrlId, dst: url });
    }
    return url;
  }

  /** A page type of the domain's, which the crawler's path rules govern; the seed and images are exempt. */
  isDomainType(type: string): boolean {
    return type !== 'seed' && type !== 'image' && urlTypes().includes(type);
  }

  /**
   * Corrects the type of a url that is already queued, for a page that turned
   * out to carry another record than its url shape promised. The page is not
   * fetched again: scrape it with the right method in the same pass, then retype
   * it so a later run dispatches correctly. The correction sticks - a link
   * queued from another page does not revert it.
   *
   * Pass the record the crawl is holding (`this.siteUrl`), not just its url: the
   * validation after this scrape must ask the questions for the page's real type,
   * not for the guess that queued it.
   */
  retypeUrl(url: SiteUrl | string, type: string) {
    if (!urlTypes().includes(type)) {
      throw new Error(`Unknown url type "${type}": this domain queues ${urlTypes().join(', ')}`);
    }
    const href = typeof url === 'string' ? this.absolute(url) : url.url;
    if (!href) return null;
    if (typeof url !== 'string') url.type = type;
    const hash = this.hashUrl(href);
    this.urlTypes.set(hash, type);
    return this.table('url').append({
      url: href,
      site: this.site.id,
      hash,
      type,
    });
  }

  /** Buffers the URL's status, version and validation note. */
  updateUrl(url: SiteUrl) {
    return this.table('url').append({
      id: url.id,
      version: url.version,
      status: url.status,
      data: url.data,
    });
  }

  async getUrl(url: string) {
    const where: Filter = /^\d+$/.test(url) ? { id: url } : { hash: this.hashUrl(url) };
    const rows = await this.table('url').select({ site: '*' }, { where });
    if (rows.length !== 1) {
      throw new Error(`Url not found: ${url}`);
    }
    return rows[0] as unknown as SiteUrl;
  }

  stats(): string {
    return this.tableList
      .filter((table) => table.recordList.length > 0)
      .map((table) => `${table.name}: ${table.recordList.length}`)
      .join(', ');
  }

  /**
   * Writes the buffered records of the page just scraped, all or nothing. A
   * domain passes sqlex's flush options for the child rows a page replaces, and
   * does its own bookkeeping after `super.flush` resolves.
   */
  flush(options?: Parameters<Database['flush']>[0]) {
    return super.flush(options).catch((err: any) => {
      throw new Error(`${err?.message ?? err}\nflushing: ${this.dirtySummary()}`);
    });
  }

  /** The buffered records about to be written, a few labels per table, for flush error messages. */
  protected dirtySummary(): string {
    const parts = this.tableList
      .filter((table) => table.recordList.length > 0)
      .map((table) => {
        const labels = table.recordList
          .slice(0, 3)
          .map((record) => label(record))
          .join(', ');
        return `${table.name}: ${table.recordList.length} [${labels}]`;
      });
    return parts.join('; ') || 'nothing';
  }

  clear() {
    super.clear();
    this.urlFetch = null;
    return this;
  }
}

/** Drops undefined fields, which sqlex refuses to assign. */
export function defined<T extends object>(fields: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined),
  ) as Partial<T>;
}

/** Identifies a buffered record in error messages by its most meaningful field. */
function label(record: Record): string {
  return String(
    record.get('code') ??
      record.get('url') ??
      record.get('name') ??
      record.get('value') ??
      record.get('id') ??
      '(record)',
  );
}
