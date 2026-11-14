// A minimal domain that exercises the core:
// pages with a title, queued from the links on each page. Registered before
// every test file, as a deployment's entry registers its domain. Its table is
// test/support/schema.sql, loaded after the core's by scripts/test-schema.ts.

import { resolve } from 'path';

import { XDocument } from 'gumbo-html';
import { Database } from 'sqlex';
import { z } from 'zod';

import { Crawler } from '../../src/core/base-crawler';
import { CoreDatabase } from '../../src/core/base-database';
import { DomainConfig, useDomain } from '../../src/core/domain';
import { Finding } from '../../src/core/issues';
import { SiteUrl } from '../../src/core/models';
import type { DomainTool } from '../../src/mcp/tools';

export class TestDatabase extends CoreDatabase {
  /** Records the page a url produced: its title and, optionally, its body. */
  addPage(url: SiteUrl, title: string, body?: string) {
    return this.table('page').append({
      site: this.site.id,
      url: url.id,
      title,
      ...(body === undefined ? {} : { body }),
    });
  }
}

export class TestCrawler extends Crawler<TestDatabase> {
  async scrapeSeed(doc: XDocument): Promise<void> {
    await this.scrapePage(doc);
  }

  async scrapePage(doc: XDocument): Promise<void> {
    this.db.addPage(this.siteUrl, doc.innerText.trim());
    for (const a of doc.find('a[href]')) this.db.addUrl(a.attr('href')!, 'page', this.siteUrl.id);
  }

  async validate(url: SiteUrl): Promise<Finding[]> {
    if (url.data) return [];
    const [row] = await this.db.query<{ title: string }[]>(
      'select title from page where url_id = ?',
      url.id,
    );
    if (!row) return [{ code: 'no_page', detail: 'no page was saved for this url' }];
    return row.title ? [] : [{ code: 'no_title', detail: 'page has no title' }];
  }
}

const inspectPage = (db: Database): DomainTool => ({
  name: 'inspectPage',
  readOnly: true,
  description: 'The page a url produced: its title and body.',
  schema: { url: z.string().describe('The url id') },
  async execute({ url }) {
    const [row] = await db.query<{ title: string; body: string | null }[]>(
      'select title, body from page where url_id = ?',
      Number(url),
    );
    return row ? `title: ${row.title}\nbody: ${row.body ?? '-'}` : 'no page';
  },
});

export const testDomain: DomainConfig = {
  name: 'test',
  urlTypes: ['page'],
  schema: {
    files: [resolve(__dirname, 'schema.sql')],
    migrations: [],
    version: 1,
  },
  database: TestDatabase,
  crawler: TestCrawler,
  expectations: {
    parse(raw, siteName) {
      if (typeof raw !== 'object' || raw === null)
        throw new Error(`crawlers/${siteName}.ts: site.expect must be an object`);
      return raw;
    },
    shortfalls(expect, metrics) {
      const range = (expect as { pages?: [number, number] }).pages;
      if (!range) return [];
      const [min, max] = range;
      return metrics.pages < min || metrics.pages > max
        ? [
            {
              code: 'pages',
              detail: `${metrics.pages} pages were saved; the crawler expects ${min}-${max}`,
            },
          ]
        : [];
    },
  },
  async metrics(siteId, db) {
    const [row] = await db.query<{ pages: string; titled: string }[]>(
      `select count(*) as pages, count(*) filter (where title <> '') as titled from page where site_id = ? and status = 'active'`,
      siteId,
    );
    return { pages: Number(row.pages), titled: Number(row.titled) };
  },
  metricRules: {
    pages: { label: 'pages', regression: { kind: 'drop', percent: 20 } },
    titled: {
      label: 'pages with a title',
      regression: { kind: 'share', of: 'pages', points: 10 },
    },
  },
  pageGone: (url, db) =>
    db.query("update page set status = 'gone' where url_id = ?", url.id).then(() => undefined),
  inspectTool: 'inspectPage',
  tools: ({ db }) => [inspectPage(db)],
  api: {
    resources: {
      Page: {
        filter: { fields: ['site', 'url', 'status'] },
        sort: { fields: ['id', 'title'], default: ['id'] },
        include: { relations: ['site', 'url'] },
      },
    },
  },
};

useDomain(testDomain);
