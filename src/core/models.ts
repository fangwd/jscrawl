import { ConnectionInfo } from 'sqlex';

export type Config = {
  database: ConnectionInfo;
  store: {
    html?: string;
    images?: string;
  };
  /** Where the site crawler modules live (a separate repository; see core/sites.ts). */
  sites?: {
    /** Absolute, or relative to the repository root. Default: `crawlers`. */
    dir?: string;
  };
};

export type PageSnapshots = 'gzip' | 'raw' | 'off';

export interface CrawlerOptions {
  id: number;
  name: string;
  waitTime: number;
  randomWait: number;
  maxRetryCount: number;
  /** Seconds a request may go without an answer before it is retried. */
  requestTimeout: number;
  /** A type the deployment's proxy provider offers (see core/proxy.ts); null: fetched directly. */
  proxyType: string | null;
  /** Where the proxy's requests come from: ISO 3166-1 alpha-2, uppercase; null: any. */
  proxyCountry: string | null;
  usePuppeteer: boolean;
  pageSnapshots: PageSnapshots;
  allow: string[];
  disallow: string[];
  /** Minutes between scheduled re-crawls; null when the site is re-crawled only by hand. */
  refreshMinutes: number | null;
}

/** Pacing and locale a crawler module exports as `site`; `SEED_URL` names its entry page. */
export interface SiteConfig {
  waitTime?: number;
  randomWait?: number;
  /** Concurrent fetch loops; read only when the site is first registered, the site row holds it after. Default 1. */
  threadCount?: number;
  maxRetryCount?: number;
  /**
   * Seconds a request may go without an answer - connecting, through a proxy
   * too, or between bytes of the response - before it is retried. Default 30;
   * a site behind a slow proxy may need more.
   */
  requestTimeout?: number;
  usePuppeteer?: boolean;
  /**
   * Fetch through a proxy from the deployment's proxy provider instead of
   * directly: `type` is one the provider offers, `country` where the requests
   * should come from - for a site that prices by the visitor's country.
   * Omitted, requests go out directly.
   */
  proxy?: { type: string; country?: string };
  /** Saved HTML/JSON responses for replay, not a fetch cache. Defaults to gzip. */
  pageSnapshots?: PageSnapshots;
  /**
   * Url paths the crawl keeps to, in robots.txt syntax (`*`, a trailing `$`);
   * the longest matching rule wins. They apply to all domain page types;
   * the seed and images are exempt.
   */
  allow?: string[];
  disallow?: string[];
  /**
   * The part of the site the user asked for, in words ("pizzas only",
   * "everything except the blog"); omitted for the whole site.
   * Coverage and triage read it, so pages left out on purpose are not chased
   * as missing.
   */
  scope?: string;
  /**
   * How often the whole site is re-crawled once it has been crawled at least
   * once: `30m`, `6h`, `1d`, counted from the start of the last crawl. Omitted,
   * it is re-crawled only by hand.
   */
  refresh?: string;
  /**
   * What the request implies a finished crawl holds, in the domain's terms,
   * e.g. `{ products: [40, 80], fields: ['price', 'image'] }` for a shop:
   * parsed by the domain at registration, checked on the test pages at build
   * time and on the site's saved records after each complete crawl.
   */
  expect?: unknown;
  currency?: string;
  locale?: string;
}

export interface Site {
  id: number;
  name: string;
  currency: string | null;
  locale: string | null;
  scope: string | null;
  expect: unknown | null;
  /** Concurrent fetch loops in a crawl; the module's `threadCount` seeds it when the site is first registered. */
  threadCount: number;
  crawler: CrawlerOptions;
}

export interface SiteUrl {
  id: number;
  url: string;
  type: string;
  data: string | null;
  status: number;
  version: number;
  site: {
    id: number;
    name: string;
  };
}

/** How a crawl that stopped itself because the site refused it exits; its run is recorded as blocked. */
export const BLOCKED_EXIT_CODE = 75;

export enum UrlStatus {
  ScrapeFailed = -2,
  FetchFailed = -1,
  Idle = 0,
  Busy = 1,
  Done = 2,
  /** Not fetched because crawler path rules or robots.txt exclude it. */
  Disallowed = 3,
}
