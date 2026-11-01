import { parseSitemap, parseSitemapIndex, sitemapInventory } from '../src/core/sitemap';
import { fetching } from './support/fakeFetch';

test('parseSitemap', async () => {
  const xml = `
  <urlset>
    <url>
      <loc>https://example.com/foo</loc>
      <lastmod>2019-01-09</lastmod>
      <changefreq>daily</changefreq>
      <priority>0.8</priority>
    </url>
    <url>
      <loc>https://example.com/bar</loc>
      <lastmod>2019-01-09</lastmod>
      <changefreq>daily</changefreq>
      <priority>0.8</priority>
    </url>
  </urlset>    
  `;
  const result = await parseSitemap(xml);
  expect(result.length).toBe(2);
  expect(result[0].loc).toBe('https://example.com/foo');
});

test('an index lists sitemaps, and a urlset or an error page lists none', async () => {
  const index = `<sitemapindex>
    <sitemap><loc>https://example.com/products.xml</loc></sitemap>
    <sitemap><loc>https://example.com/categories.xml</loc></sitemap>
  </sitemapindex>`;
  expect(await parseSitemapIndex(index)).toEqual([
    'https://example.com/products.xml',
    'https://example.com/categories.xml',
  ]);
  expect(await parseSitemapIndex('<urlset><url><loc>https://example.com/a</loc></url></urlset>')).toEqual([]);
  expect(await parseSitemapIndex('<html><body>404</body></html>')).toEqual([]);
  expect(await parseSitemap('<html><body>404</body></html>')).toEqual([]);
});

test('the inventory follows robots.txt through a sitemap index', async () => {
  const files: Record<string, string> = {
    'https://example.com/robots.txt': 'User-agent: *\nDisallow: /cart\nSitemap: https://example.com/index.xml\n',
    'https://example.com/index.xml':
      '<sitemapindex><sitemap><loc>https://example.com/products.xml</loc></sitemap></sitemapindex>',
    'https://example.com/products.xml':
      '<urlset><url><loc>https://example.com/a</loc></url><url><loc>https://example.com/b</loc></url></urlset>',
  };
  const inventory = await sitemapInventory('https://example.com/', fetching(files));
  expect(inventory).toEqual([
    { url: 'https://example.com/products.xml', urls: ['https://example.com/a', 'https://example.com/b'] },
  ]);
});

test('without robots.txt it tries /sitemap.xml, and an unreachable file is a hole, not an error', async () => {
  const files: Record<string, string> = {
    'https://example.com/sitemap.xml': '<urlset><url><loc>https://example.com/only</loc></url></urlset>',
  };
  const inventory = await sitemapInventory('https://example.com/', fetching(files));
  expect(inventory).toEqual([{ url: 'https://example.com/sitemap.xml', urls: ['https://example.com/only'] }]);
});
