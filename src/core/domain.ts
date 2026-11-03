// The domain a deployment runs: what the app configures and the core reads
// (separate-core-app-impl.md §4). One domain per deployment, registered once at
// start by the deployment's entry (src/domain.ts) and read by the core at run
// time; the core never imports an app.

import type { ConnectionInfo, ConnectionPool, Schema } from 'sqlex';
import type { ApiConfig } from 'sqlex/api';
import type { CoreDatabase } from './base-database';
import type { Crawler } from './base-crawler';
import type { Config, SiteUrl } from './models';
import type { XDocument } from 'gumbo-html';
import type { ZodRawShape } from 'zod';
import type { DomainTool, DomainToolDeps } from '../mcp/tools';
import type { Suspects } from './coverage';
import type { FixtureEntry } from './fixtures';

/** Page types every domain has: the site's entry page, and the images its pages refer to. */
export const CORE_URL_TYPES = ['seed', 'image'] as const;

export interface DomainConfig {
  /** Short name, used in the site API, the API prefix and logs. */
  name: string;
  /** Page types the domain's crawlers may queue, beyond the core's. `addUrl` rejects any other. */
  urlTypes: readonly string[];
  /** The domain's tables: schema files loaded after the core's, migrations run after the core's, and a version. */
  schema: { files: string[]; migrations: string[]; version: number };
  /** Extends CoreDatabase with the app's typed write methods. */
  database: new (connection: ConnectionPool | ConnectionInfo, schema?: Schema) => CoreDatabase;
  /** The base class the app's site crawlers extend. */
  crawler: new (db: any, config: Config) => Crawler<any>;
  /** site.expect: parsing (throws naming what is wrong) and the shortfalls of a site's metrics against it. */
  expectations: {
    parse(raw: unknown, siteName: string): unknown;
    shortfalls(expect: unknown, metrics: Record<string, number>): string[];
    /** What a test page's preview lacks of what site.expect requires of every page of its kind. */
    pageShortfalls?(expect: unknown, tables: { [table: string]: { count: number; records: object[] } }): string[];
  };
  /** The domain's fixture contract: what a pages.json entry may carry beyond type, file and url, and what a page must yield. */
  fixtures?: {
    entry: ZodRawShape;
    /** Problems with the listing before any page runs: entries that lack what the domain requires. */
    contracts?(pages: FixtureEntry[]): string[];
    /** Problems with what the crawler extracted from a fixture page; `records` are the buffered rows by table. */
    check(page: { entry: FixtureEntry; doc: XDocument; records: (table: string) => unknown[] }): { problems: string[]; summary?: string };
  };
  /** Pages whose type their content contradicts, for the coverage report; candidates, not verdicts. */
  suspects?(db: CoreDatabase, siteId: number): Promise<Suspects[]>;
  /** The domain's records over HTTP: sqlex/api resources the core mounts under /api/d/, beside its own site and url. */
  api: Pick<ApiConfig<unknown>, 'resources' | 'defaults'>;
  /** Named counts describing a site's catalogue; taken after each complete crawl and checked against site.expect. */
  metrics(siteId: number, db: CoreDatabase): Promise<Record<string, number>>;
  /** A label per metric, and what drop between two complete crawls is a regression rather than churn. */
  metricRules: Record<string, { label: string; regression?: RegressionRule }>;
  /** A page answered 404 or 410: what it produced is no longer on the site. */
  pageGone?(url: SiteUrl, db: CoreDatabase): Promise<void>;
  /** The domain's "what did this page produce" tool; the core's inspectUrl and skills name it. Must be among `tools`. */
  inspectTool: string;
  /** The domain's agent tools, mounted beside the core's at /mcp. */
  tools?(deps: DomainToolDeps): DomainTool[];
  /** The domain's part of the agent's skills: a skills directory merged over the core's, and instructions appended to the agent's. */
  skills?: { dir: string; instructions?: string };
  /** Presentation hints for the dashboard's renderer. All optional: without them every model renders from its schema alone. */
  ui?: UiHints;
  /**
   * The live check: what a url's page yields now against what was saved from it.
   * `keys` names the tables compared and how a row is matched, by table: own
   * columns, or a path through a foreign key ('product.code'). A table whose key
   * is its own columns only is the page's: its saved rows are those linked to the
   * url. Any other is compared under the parent rows the page yields.
   */
  liveCheck?: { keys: Record<string, string[]> };
  /** Services the domain relies on; a tool that needs one is mounted only when it is set. */
  services?: { imaged?: string };
  /** The site export the core serves, the agent checks and the CLI writes; omit to mount none of it. */
  feed?: {
    /** The export as one file, a summary of what it holds, and its first rows for a look. */
    export(siteId: number, db: CoreDatabase): Promise<{ bytes: Uint8Array; summary: string; sample?: string }>;
    filename(site: { id: number; name: string }): string;
    contentType: string;
    /** The format reference, markdown, served at /api/docs/feed-format. */
    docs?: string;
  };
}

/** Field names and paths are sqlex's: a model's fields, through relations ('product.site.currency'). */
export interface UiHints {
  /** Models in the nav. `perSite`: listed per site, filtered by the model's `site` column. */
  nav?: { model: string; label: string; perSite?: boolean }[];
  models?: Record<string, ModelHints>;
  /** Amounts formatted as money: 'Model.field', and the path from that model to its currency code. */
  money?: { amount: string; currency: string }[];
  /** Site metrics shown as tiles, labelled. */
  overview?: { metric: string; label: string }[];
  /** Columns the live check's diff leads with, 'table.column'. */
  liveCheck?: { highlight: string[] };
}

export interface ModelHints {
  /** The field that names a row; cards and links show it. */
  title?: string;
  subtitle?: string;
  /** A path to an image url; with `title`, the model lists as cards. */
  image?: string;
  /** What a list shows, in order; paths through a has-many render the set (a range for amounts, any-of for flags). */
  columns?: string[];
  /** A path rows group by where they list as another row's has-many. */
  groupBy?: string;
}

export type RegressionRule =
  /** The metric fell by at least `percent` of its previous value. */
  | { kind: 'drop'; percent: number }
  /** The metric's share of metric `of` fell by at least `points` percentage points. */
  | { kind: 'share'; of: string; points: number };

let current: DomainConfig | undefined;

/** Registers the deployment's domain. Called once, before any crawler or database is made. */
export function useDomain(config: DomainConfig): void {
  current = config;
}

export function domain(): DomainConfig {
  if (!current) throw new Error('No domain registered: the deployment entry must call useDomain() first');
  return current;
}

/** Every page type the deployment may queue, the core's and the domain's. */
export function urlTypes(): string[] {
  return [...CORE_URL_TYPES, ...domain().urlTypes];
}

/** The page types a crawl fetches and scrapes: the seed and the domain's. */
export function crawledUrlTypes(): string[] {
  return ['seed', ...domain().urlTypes];
}
