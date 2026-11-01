// Runs a site crawler on saved pages and returns the records it would save,
// by table; nothing is written. Shared by the --scrape-file CLI command and
// the agent's scrapePreview/dryRun tools.

import { Record } from 'sqlex';
import { parse } from 'gumbo-html';
import Crawler from './crawler';
import { readPage } from './fetch';
import { CrawlerDatabase } from './database';
import { siteModule } from './sites';
import { Config, CrawlerOptions, SiteUrl } from './models';
import { checkCompleteness, CompletenessReport, SectionContract } from './completeness';

export interface PreviewTable {
  count: number;
  records: object[];
}

/** One saved page to run through a crawler. */
export interface PreviewPage {
  type: string;
  file: string;
  url?: string;
  sections?: SectionContract[];
}

/** The outcome for one page: its tables, or the error the crawler threw. */
export interface PreviewPageResult {
  type: string;
  file: string;
  url: string;
  ok: boolean;
  error?: string;
  completeness?: CompletenessReport;
  tables: { [table: string]: PreviewTable };
}

// parent records (not saved, so without ids) are shown by their code, url or name
const label = (record: any) => record.code ?? record.url ?? record.name ?? record.value ?? record.id ?? '(record)';

async function previewDatabase(config: Config, name: string) {
  const Plugin = siteModule(name, config).default;
  const db = new CrawlerDatabase(config.database);
  await db.buildSchema();
  if (!(await db.init(name))) {
    // not registered yet: a stand-in site, as nothing is flushed
    db.site = { id: 0, name, currency: null, locale: null, scope: null, expect: null, crawler: { usePuppeteer: false } as CrawlerOptions };
  }
  return { Plugin, db };
}

/**
 * The crawler for one saved page. What its handler fetches is recorded in
 * `<file>.fetches` (a crawl snapshot already has the crawl's) and replayed from
 * there, so a fixture is checked against the same responses each time.
 */
function previewCrawler(Plugin: any, db: CrawlerDatabase, config: Config, file: string): Crawler {
  const crawler: Crawler = new Plugin(db, config);
  crawler.fetches = { dir: `${file}.fetches` };
  return crawler;
}

/** The tables with records, optionally filtered to the names the caller asked for. */
function previewTables(db: CrawlerDatabase, limit: number, tables?: string[]): { [table: string]: PreviewTable } {
  const out: { [table: string]: PreviewTable } = {};
  for (const table of db.tableList.filter((t) => t.recordList.length > 0)) {
    if (tables && !tables.includes(table.name)) continue;
    out[table.name] = {
      count: table.recordList.length,
      records: table.recordList.slice(0, limit).map((record) => {
        const row: { [field: string]: unknown } = {};
        for (const field of table.model.fields) {
          const value = record.get(field.name);
          if (value !== undefined && !Array.isArray(value)) row[field.name] = value instanceof Record ? label(value) : value;
        }
        return row;
      }),
    };
  }
  return out;
}

export async function scrapePreview(
  config: Config,
  name: string,
  type: string,
  file: string,
  pageUrl = 'https://example.invalid/page',
  limit = Infinity
): Promise<{ [table: string]: PreviewTable }> {
  const { Plugin, db } = await previewDatabase(config, name);
  try {
    const url: SiteUrl = { id: 0, url: pageUrl, type, data: null, status: 0, version: 0, site: { id: db.site.id, name } };
    await previewCrawler(Plugin, db, config, file).scrape(await readPage(file, pageUrl), url);
    return previewTables(db, limit);
  } finally {
    await db.end();
  }
}

/**
 * Run one crawler over several saved pages without writing anything. Each page
 * is attempted independently, so one broken fixture does not hide the others;
 * records are cleared between pages.
 */
export async function scrapePreviews(
  config: Config,
  name: string,
  pages: PreviewPage[],
  limit = Infinity,
  tables?: string[]
): Promise<PreviewPageResult[]> {
  const { Plugin, db } = await previewDatabase(config, name);
  try {
    const results: PreviewPageResult[] = [];
    for (const page of pages) {
      const pageUrl = page.url ?? 'https://example.invalid/page';
      const result: PreviewPageResult = { type: page.type, file: page.file, url: pageUrl, ok: true, tables: {} };
      const url: SiteUrl = { id: 0, url: pageUrl, type: page.type, data: null, status: 0, version: 0, site: { id: db.site.id, name } };
      try {
        const crawler = previewCrawler(Plugin, db, config, page.file);
        const response = await readPage(page.file, pageUrl);
        // Source evidence comes from the fixture, independently of handlers
        // overriding scrape() or replacing/mutating their working document.
        const source = page.sections ? parse(response.text(), { baseUrl: response.url }) : undefined;
        await crawler.scrape(response, url);
        if (page.sections) {
          result.completeness = checkCompleteness(source!, page.sections, (table) => db.table(table).recordList);
          if (!result.completeness.ok) {
            result.ok = false;
            result.error = `Incomplete extraction: ${result.completeness.problems.join('; ')}`;
          }
        }
        result.tables = previewTables(db, limit, tables);
      } catch (err: any) {
        result.ok = false;
        result.error = err?.stack?.split('\n').slice(0, 6).join('\n') ?? String(err);
      }
      db.clear();
      results.push(result);
    }
    return results;
  } finally {
    await db.end();
  }
}
