import { XDocument } from 'gumbo-html';

import {
  checkClassifier,
  classifierOf,
  renderClassified,
  sampleUrls,
} from '../src/core/classifier-check';

const classifier = {
  // as the template's: it resolves a link against the page the crawler is on
  siteUrl: undefined as { url: string } | undefined,
  urlType(href: string) {
    const { pathname } = new URL(href, this.siteUrl!.url);
    if (pathname.startsWith('/products/')) return 'product';
    if (pathname.startsWith('/collections/')) return 'category';
    return undefined;
  },
  pageKind(doc: XDocument) {
    if (doc.exists('body.product')) return 'product';
    if (doc.exists('body.collection')) return 'category';
    if (doc.exists('body.cms')) return 'cms';
    if (doc.exists('body.landing')) return 'landing';
    if (doc.exists('body.error')) throw new Error('Unrecognised template');
    return 'unknown';
  },
};

const pages: Record<string, string> = {
  'https://shop.test/products/desk': '<body class="product">',
  'https://shop.test/products/gift-guide': '<body class="collection">',
  'https://shop.test/products/redesigned': '<body class="pdp-v2">',
  'https://shop.test/range/oak': '<body class="product">',
  'https://shop.test/about': '<body class="cms">',
  'https://shop.test/products/summer-sale': '<body class="landing">',
  'https://shop.test/products/broken': '<body class="error">',
  'https://shop.test/blog/post': '<body class="error">',
};

test('each url is classified by its shape and by its page, and disagreements are named', async () => {
  const seen: string[] = [];
  const result = await checkClassifier(
    classifier,
    [...Object.keys(pages), 'https://shop.test/products/gone'],
    ['category', 'product'],
    async (url) =>
      url.endsWith('/about')
        ? { skipped: 'robots.txt disallows it' }
        : pages[url]
          ? { status: 200, html: pages[url], url }
          : { status: 404, html: '', url },
    (url, queuedAs) => {
      classifier.siteUrl = { url };
      seen.push(`${url} ${queuedAs}`);
    },
  );
  expect(
    result.map((page) => [new URL(page.url).pathname, page.queuedAs, page.pageKind, page.problem]),
  ).toEqual([
    ['/products/desk', 'product', 'product', undefined],
    [
      '/products/gift-guide',
      'product',
      'category',
      'queued as product, but the page is a category: retyped at scrape time, or a wrong rule',
    ],
    [
      '/products/redesigned',
      'product',
      'unknown',
      'queued as product, but pageKind() does not recognise the page: its scrape would throw',
    ],
    [
      '/range/oak',
      null,
      'product',
      'dropped, but the page is a product: urlType() misses this shape',
    ],
    ['/about', null, undefined, undefined],
    ['/products/summer-sale', 'product', 'landing', undefined],
    [
      '/products/broken',
      'product',
      'unknown',
      'queued as product, but pageKind() does not recognise the page: its scrape would throw',
    ],
    ['/blog/post', null, 'unknown', undefined],
    ['/products/gone', 'product', undefined, 'HTTP 404'],
  ]);
  expect(seen.slice(0, 2)).toEqual([
    'https://shop.test/products/desk null',
    'https://shop.test/products/desk product',
  ]);
  expect(result[4].skipped).toBe('robots.txt disallows it');
  expect(renderClassified(result)).toContain('5 of 9 pages disagree');
  expect(renderClassified(result)).toContain(
    'urlType: null (dropped) | not fetched: robots.txt disallows it',
  );
});

test('the class nearest the crawler says how it classifies', () => {
  class Profile {
    classifier() {
      return { pageKind: () => 'product' };
    }
  }
  class OnProfile extends Profile {}
  class OwnRules extends Profile {
    urlType() {
      return 'category';
    }
    pageKind() {
      return 'category';
    }
  }
  class OwnPageKindOnly extends Profile {
    pageKind() {
      return 'index';
    }
  }
  class Adapted extends OwnRules {
    classifier() {
      return { urlType: () => 'product', pageKind: () => 'product' };
    }
  }
  expect(classifierOf(new OnProfile()).from).toBe('its classifier()');
  const own = classifierOf(new OwnRules());
  expect(own.from).toBe('its own urlType() and pageKind()');
  expect(own.classifier.urlType!('https://shop.test/x')).toBe('category');
  // half a classifier of its own is not one: the profile's is asked
  expect(classifierOf(new OwnPageKindOnly()).from).toBe('its classifier()');
  expect(classifierOf(new Adapted()).classifier.urlType!('https://shop.test/x')).toBe('product');
  expect(() => classifierOf(new (class {})())).toThrow('neither urlType() and pageKind()');
});

test('a crawler that does not type urls is shown by page kind only', async () => {
  const result = await checkClassifier(
    {
      pageKind: (doc: XDocument) => (doc.exists('body.product') ? 'product' : 'unknown'),
    },
    ['https://shop.test/a', 'https://shop.test/b'],
    ['category', 'product'],
    async (url) => ({
      status: 200,
      html: url.endsWith('/a') ? '<body class="product">' : '<body>',
      url,
    }),
  );
  expect(result.map((page) => [page.queuedAs, page.pageKind, page.problem])).toEqual([
    [undefined, 'product', undefined],
    [undefined, 'unknown', undefined],
  ]);
  const text = renderClassified(result, 'its classifier()');
  expect(text).toContain('classified by its classifier()');
  expect(text).toContain('urlType: - | pageKind: unknown');
  expect(text).toContain('does not type urls by their shape');
});

test('a urlType() that drops everything is called out, and samples are bounded', async () => {
  const result = await checkClassifier(
    { urlType: () => undefined, pageKind: () => 'cms' },
    ['https://shop.test/a', 'https://shop.test/b', 'https://shop.test/c'],
    ['product'],
    async (url) => ({ status: 200, html: '<body>', url }),
  );
  expect(renderClassified(result)).toContain('urlType() dropped every url');
  const shapes = [
    { shape: '/products/*', count: 9, samples: ['a', 'b', 'c'] },
    { shape: '/<slug>', count: 2, samples: ['d', 'a'] },
    { shape: '/products/*', count: 4, samples: ['e', 'f'] },
  ];
  expect(sampleUrls(shapes, 2, 10)).toEqual(['a', 'b', 'd']);
  expect(sampleUrls(shapes, 2, 2)).toEqual(['a', 'b']);
});
