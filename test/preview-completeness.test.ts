import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { CrawlerDatabase } from '../src/core/database';
import { siteModule } from '../src/core/sites';
import { scrapePreviews } from '../src/core/preview';
import { SectionContract } from '../src/core/completeness';
import type { Config } from '../src/core/models';

jest.mock('../src/core/database', () => ({ CrawlerDatabase: jest.fn() }));
jest.mock('../src/core/sites', () => ({ siteModule: jest.fn() }));

const cwd = mkdtempSync(join(tmpdir(), 'jscrawl-completeness-'));
const file = join(cwd, 'product.html');
const page = '<p id="description">Weathered walnut</p><div role="tabpanel" id="apps">Benchtops Shelving</div>';
const sections: SectionContract[] = [
  { name: 'Description', selector: '#description', status: 'extracted', evidence: 'Weathered walnut',
    expect: [{ table: 'product', field: 'description', contains: ['Weathered walnut'] }] },
  { name: 'Applications', selector: '#apps', status: 'extracted', evidence: 'Benchtops',
    expect: [{ table: 'product_attribute_value', field: 'value', where: { 'attribute.name': 'Applications' },
      values: ['Shelving'], minCount: 2 }] },
];
let saveDescription = true;
let db: any;
const record = (data: any) => ({ ...data, get: (name: string) => data[name] });
class FixtureCrawler {
  constructor(private buffer: any) {}
  async scrape(response: any) {
    this.buffer.table('product').recordList.push(record({ name: 'Walnut', description: saveDescription ? 'Weathered walnut' : undefined }));
    for (const value of ['Benchtops', 'Shelving']) {
      this.buffer.table('product_attribute_value').recordList.push(record({ value, attribute: { name: 'Applications' } }));
    }
  }
}

beforeAll(() => writeFileSync(file, page));
afterAll(() => rmSync(cwd, { recursive: true, force: true }));
beforeEach(() => {
  saveDescription = true;
  const tables = [
    { name: 'product', model: { fields: [{ name: 'name' }, { name: 'description' }] }, recordList: [] },
    { name: 'product_attribute_value', model: { fields: [{ name: 'value' }] }, recordList: [] },
  ];
  db = { site: { id: 0 }, buildSchema: jest.fn(), init: jest.fn().mockResolvedValue({ id: 0 }),
    tableList: tables, table: (name: string) => tables.find((table) => table.name === name),
    clear: () => tables.forEach((table) => { table.recordList.length = 0; }), end: jest.fn(), flush: jest.fn() };
  (CrawlerDatabase as unknown as jest.Mock).mockImplementation(() => db);
  (siteModule as jest.Mock).mockReturnValue({ default: FixtureCrawler });
});

test('completion reads the fixture independently and checks the full buffer despite output limits and filters', async () => {
  const [result] = await scrapePreviews({} as Config, 'shop', [{ type: 'product', file, sections }], 0, ['product']);
  expect(result.ok).toBe(true);
  expect(result.completeness?.sections).toHaveLength(2);
  expect(result.tables).toEqual({ product: { count: 1, records: [] } });
  expect(db.flush).not.toHaveBeenCalled();
});

test('a successful extraction with missing content fails completion and retains its diagnostic tables', async () => {
  saveDescription = false;
  const [result] = await scrapePreviews({} as Config, 'shop', [{ type: 'product', file, sections }], 1);
  expect(result.ok).toBe(false);
  expect(result.error).toContain('Description: product.description: expected at least 1 nonempty');
  expect(result.tables.product.count).toBe(1);
  expect(result.tables.product_attribute_value.count).toBe(2);
  expect(db.flush).not.toHaveBeenCalled();
});
