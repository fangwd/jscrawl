import { renderSurvey, spread, surveySite } from '../src/core/survey';
import { fetching, sitemapXml } from './support/fakeFetch';

const origin = 'https://shop.test';

test('a survey groups what the sitemaps list and the home page links by url shape', async () => {
  const products = Array.from({ length: 40 }, (_, i) => `/products/item-${i}`);
  const survey = await surveySite(
    `${origin}/`,
    fetching({
      [`${origin}/robots.txt`]: `# hello\nUser-agent: badbot\nDisallow: /\n\nUser-agent: *\nAllow: /\nDisallow: /cart # no\nCrawl-delay: 2\nSitemap: ${origin}/sitemap.xml`,
      [`${origin}/sitemap.xml`]: `<sitemapindex><sitemap><loc>${origin}/products.xml</loc></sitemap><sitemap><loc>${origin}/pages.xml</loc></sitemap></sitemapindex>`,
      [`${origin}/products.xml`]: sitemapXml(origin, products),
      [`${origin}/pages.xml`]: sitemapXml(origin, ['/collections/desks', '/about']),
      [`${origin}/`]: `<html><body><header><nav><a href="/collections/desks">Desks</a><a href="/blog/news">Blog</a></nav></header>
        <script src="https://cdn.shopify.com/x.js"></script><a href="/products/item-1">One</a><a href="https://elsewhere.test/x">Out</a><a href="mailto:a@b.c">Mail</a></body></html>`,
    }),
  );
  expect(survey.robots).toEqual({
    rules: ['Disallow /cart', 'Crawl-delay 2'],
    more: 0,
  });
  expect(survey.sitemaps.map((file) => [file.url, file.urls])).toEqual([
    [`${origin}/products.xml`, 40],
    [`${origin}/pages.xml`, 2],
  ]);
  expect(survey.listed.urls).toBe(42);
  expect(survey.listed.shapes[0]).toEqual({
    shape: '/products/*',
    count: 40,
    samples: [
      `${origin}/products/item-0`,
      `${origin}/products/item-20`,
      `${origin}/products/item-39`,
    ],
  });
  expect(survey.home!.platform).toEqual(['shopify']);
  expect(survey.home!.links.urls).toBe(3);
  expect(survey.home!.menu.shapes.map((group) => group.shape).sort()).toEqual([
    '/blog/*',
    '/collections/*',
  ]);
  expect(survey.home!.unlisted).toEqual(['/blog/*']);
  expect(renderSurvey(survey)).toContain('sitemaps: 2 files, 42 distinct urls');
});

test('a site with no sitemap and no robots.txt still surveys its home page', async () => {
  const survey = await surveySite(
    `${origin}/`,
    fetching({ [`${origin}/`]: '<a href="/p/1">x</a>' }),
  );
  expect(survey.robots).toBeNull();
  expect(survey.sitemaps).toEqual([]);
  expect(survey.home!.links.shapes[0].shape).toBe('/p/*');
  expect(renderSurvey(survey)).toContain('sitemaps: none found');
  expect(renderSurvey(survey)).toContain('platform: (none detected in the home page)');
});

test('spread takes members from across a list', () => {
  expect(spread([1, 2], 3)).toEqual([1, 2]);
  expect(spread([1, 2, 3, 4, 5, 6, 7], 3)).toEqual([1, 4, 7]);
});
