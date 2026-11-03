import { ConnectionInfo } from "sqlex";

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
}

export type PageSnapshots = 'gzip' | 'raw' | 'off';

export interface CrawlerOptions {
  id: number;
  name: string;
  waitTime: number;
  randomWait: number;
  threadCount: number;
  maxRetryCount: number;
  proxyType: string | null;
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
  threadCount?: number;
  maxRetryCount?: number;
  usePuppeteer?: boolean;
  /** Saved HTML/JSON responses for replay, not a fetch cache. Defaults to gzip. */
  pageSnapshots?: PageSnapshots;
  /**
   * Url paths the crawl keeps to, in robots.txt syntax (`*`, a trailing `$`);
   * the longest matching rule wins. They hold for category and product urls;
   * the seed and images are exempt.
   */
  allow?: string[];
  disallow?: string[];
  /**
   * The part of the catalogue the user asked for, in words ("pizzas only",
   * "everything except cleaning products"); omitted for the whole catalogue.
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
   * time and on the whole catalogue after each complete crawl.
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
  /** Never fetched: the crawler's own path rules exclude it. */
  Disallowed = 3
}
