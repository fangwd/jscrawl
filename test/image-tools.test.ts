import { createServer, Server } from 'http';
import { AddressInfo } from 'net';
import { CrawlerDatabase } from '../src/core/database';
import { domainTools } from '../src/mcp/tools';

const connection = {
  dialect: 'postgres' as const,
  connection: { host: '127.0.0.1', port: 5434, user: 'admin', password: 'secret', database: 'jscrawl_test' },
};

let db: CrawlerDatabase;
let server: Server;
let tools: ReturnType<typeof domainTools>;
/** Each job's params, as imaged received them. */
let jobs: { urls: string[]; product_type?: string }[];
let polls: number;

// A tile's face is pure; scenes are noise; the first poll finds the job still running.
const label = (url: string) =>
  url.includes('broken')
    ? { url, error: 'HTTP Error 404: Not Found' }
    : url.includes('face')
      ? { url, pure: true, kind: 'product_only', reason: 'tile face fills the frame' }
      : { url, pure: false, kind: 'scene', reason: 'a bathroom' };

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/jobs/product_images') {
      let body = '';
      req.on('data', (chunk) => (body += chunk)).on('end', () => {
        const params = JSON.parse(/name="params"\r\n\r\n(.*)\r\n/.exec(body)![1]);
        jobs.push(params);
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: `job${jobs.length - 1}` }));
      });
    } else {
      const params = jobs[Number(req.url!.replace('/jobs/job', ''))];
      const status = polls++ % 2 === 0 ? 'running' : 'succeeded';
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
        status,
        result: { classifier: 'claude-haiku-5-5', usage: { inputTokens: 900, outputTokens: 60, estimatedCostUsd: 0.00012 }, results: params.urls.map(label) },
      }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  db = new CrawlerDatabase(connection);
  await db.buildSchema();
  tools = domainTools({
    db, config: connection as any, cwd: process.cwd(), jscrawlUrl: 'http://127.0.0.1:1',
    imagedUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
  });
});

afterAll(async () => {
  await db.end();
  server.close();
});

beforeEach(async () => {
  await db.zap();
  jobs = [];
  polls = 0;
});

const tool = (name: string) => tools.find((t) => t.name === name)!;

test('classifyImages sends one gallery with its product type and lists each label', async () => {
  const urls = ['https://cdn.test/kuni-face.png', 'https://cdn.test/kuni-room.jpg', 'https://cdn.test/broken.jpg'];
  const out = await tool('classifyImages').execute({ urls, productType: 'floor tile' }, { cwd: process.cwd() });

  expect(jobs).toEqual([{ urls, product_type: 'floor tile' }]);
  expect(out).toBe([
    'classifier: claude-haiku-5-5, 900 input / 60 output tokens, est. $0.000120',
    '  pure  product_only https://cdn.test/kuni-face.png - tile face fills the frame',
    '  noise scene https://cdn.test/kuni-room.jpg - a bathroom',
    '  error https://cdn.test/broken.jpg: HTTP Error 404: Not Found',
  ].join('\n'));
});

test('imageAudit scores the saved flags against the classifier per product, typed by its category', async () => {
  const crawler = db.table('crawler').append({ name: 'tiles' });
  const site = db.table('site').append({ name: 'tiles', crawler });
  db.table('url').append({ site, url: 'https://tiles.test/floor', hash: 'floor', type: 'category' });
  await db.flush();
  db.clear();
  await db.init('tiles');
  const [listing] = await db.table('url').select('*');
  const category = db.addCategory('Floor Tiles', '/floor', { ...(listing as any), site: { id: db.site.id } }, null);
  // Kuni: face saved pure, room saved noise - both right; Shire: its face saved
  // as noise (missed) and its room as pure (wrong); Vale: nothing flagged
  const kuni = db.addProduct({ code: 'kuni', name: 'Kuni' }, { category });
  db.addProductImage(kuni, 'https://cdn.test/kuni-face.png', 'thumbnail', [], true);
  db.addProductImage(kuni, 'https://cdn.test/kuni-room.jpg', 'gallery', [], false);
  const shire = db.addProduct({ code: 'shire', name: 'Shire' }, { category });
  db.addProductImage(shire, 'https://cdn.test/shire-face.jpg', 'thumbnail', [], false);
  db.addProductImage(shire, 'https://cdn.test/shire-room.jpg', 'gallery', [], true);
  const vale = db.addProduct({ code: 'vale', name: 'Vale' }, { category });
  db.addProductImage(vale, 'https://cdn.test/vale-face.jpg');
  await db.flush();

  const out = await tool('imageAudit').execute({ site: 'tiles' }, { cwd: process.cwd() });

  expect(jobs.map((job) => job.product_type)).toEqual(['Floor Tiles', 'Floor Tiles', 'Floor Tiles']);
  expect(out).toContain('3 products of tiles; classifier: claude-haiku-5-5; 2700 input / 180 output tokens, est. $0.000360');
  expect(out).toContain('precision: 50% (1/2) - too few images saved as pure to judge (2, need 20)');
  expect(out).toContain('recall: 50% (1/2)');
  expect(out).toContain('agreed noise: 1, saved without a flag: 1, unreadable: 0');
  expect(out).toContain('products without a saved pure image the classifier found one for: 1\n  Vale (product');
  expect(out).toContain('saved noise, classifier pure (product_only): https://cdn.test/shire-face.jpg - tile face fills the frame');
  expect(out).toContain('saved pure, classifier noise (scene): https://cdn.test/shire-room.jpg - a bathroom');
});
