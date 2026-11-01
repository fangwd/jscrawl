import { CrawlerDatabase } from '../src/core/database';
import {
  addShopifyListing,
  addShopifyProduct,
  parseShopifyListing,
  parseShopifyProduct,
  shopifyListingUrl,
  shopifySitemaps,
} from '../src/core/platforms/shopify';

const connection = {
  dialect: 'postgres' as const,
  connection: { host: '127.0.0.1', port: 5434, user: 'admin', password: 'secret', database: 'jscrawl_test' },
};

const PRODUCT = {
  id: 7001,
  title: 'Modern Sofa',
  handle: 'modern-sofa',
  description: '<p>Deep seat.</p><ul><li>FSC wood</li></ul>',
  vendor: 'Koala ',
  type: 'Sofa',
  tags: ['sofa'],
  options: [
    { name: 'Colour', values: ['Black', 'Grey'] },
    { name: 'Size', values: ['2 Seater', '3 Seater'] },
  ],
  variants: [
    { id: 1, title: 'Black / 2 Seater', option1: 'Black', option2: '2 Seater', sku: 'S-B2', price: 129000, compare_at_price: 149000, available: true, weight: 45000, featured_image: { src: '//cdn.shopify.com/s/files/black.jpg?v=1' } },
    { id: 2, title: 'Black / 3 Seater', option1: 'Black', option2: '3 Seater', sku: 'S-B3', price: 179000, compare_at_price: null, available: true, featured_image: { src: '//cdn.shopify.com/s/files/black.jpg?v=1' } },
    { id: 3, title: 'Grey / 3 Seater', option1: 'Grey', option2: '3 Seater', sku: 'S-G3', price: 179000, available: false },
  ],
  images: ['//cdn.shopify.com/s/files/front.jpg?v=2', '//cdn.shopify.com/s/files/black.jpg?v=1', '//cdn.shopify.com/s/files/front.jpg?v=3'],
};

let db: CrawlerDatabase;
const q = (sql: string) => db.query<any[]>(sql);

beforeAll(async () => {
  db = new CrawlerDatabase(connection);
  await db.buildSchema();
});
afterAll(() => db.end());

beforeEach(async () => {
  await db.zap();
  const crawler = db.table('crawler').append({ name: 'shop' });
  const site = db.table('site').append({ name: 'shop', crawler, currency: 'AUD' });
  db.table('url').append({ site, url: 'https://shop.test/collections/sofas', hash: 'c', type: 'category' });
  await db.flush();
  db.clear();
  await db.init('shop');
});

test('a product .js record becomes the product, its axes, variants in dollars and its gallery', async () => {
  const json = parseShopifyProduct(JSON.stringify(PRODUCT), 'https://shop.test/products/modern-sofa.js');
  addShopifyProduct(db, json, { product: { ratingValue: 4.8 } });
  await db.flush();

  const [product] = await q(
    'select p.code, p.name, b.name as brand, p.description, p.rating_value, p.structured_data from product p join brand b on b.id = p.brand_id'
  );
  expect(product).toMatchObject({ code: '7001', name: 'Modern Sofa', brand: 'Koala', description: 'Deep seat.\nFSC wood' });
  expect(Number(product.rating_value)).toBe(4.8);
  expect(product.structured_data.shopify).toMatchObject({ handle: 'modern-sofa', type: 'Sofa' });
  expect(await q('select kind, value from product_asset')).toEqual([{ kind: 'html', value: PRODUCT.description }]);

  const variants = await q(
    `select v.code, v.sku, v.price::float, v.compare_at_price::float as was, v.availability, v.weight::float, v.weight_unit,
            string_agg(av.value, ' / ' order by a.sort_order) as options
       from product_variant v
       join product_variant_value vv on vv.variant_id = v.id
       join product_attribute_value av on av.id = vv.attribute_value_id
       join product_attribute a on a.id = av.attribute_id
      group by v.id order by v.code`
  );
  expect(variants).toEqual([
    { code: '1', sku: 'S-B2', price: 1290, was: 1490, availability: 'in_stock', weight: 45, weight_unit: 'kg', options: 'Black / 2 Seater' },
    { code: '2', sku: 'S-B3', price: 1790, was: null, availability: 'in_stock', weight: null, weight_unit: null, options: 'Black / 3 Seater' },
    { code: '3', sku: 'S-G3', price: 1790, was: null, availability: 'out_of_stock', weight: null, weight_unit: null, options: 'Grey / 3 Seater' },
  ]);
  // Grey is offered, but no variant carrying it is in stock
  expect(await q('select value, is_available from product_attribute_value order by id')).toEqual([
    { value: 'Black', is_available: true },
    { value: 'Grey', is_available: false },
    { value: '2 Seater', is_available: true },
    { value: '3 Seater', is_available: true },
  ]);

  const images = await q(
    `select u.url, pi.role, count(iv.variant_id)::int as variants
       from product_image pi join url u on u.id = pi.url_id
       left join product_image_variant iv on iv.image_id = pi.id
      group by pi.id, u.url order by pi.position`
  );
  expect(images).toEqual([
    { url: 'https://cdn.shopify.com/s/files/front.jpg', role: 'thumbnail', variants: 0 },
    { url: 'https://cdn.shopify.com/s/files/black.jpg', role: 'gallery', variants: 2 },
  ]);
});

test('a products.json page becomes listing basics at their places, each page queued', async () => {
  const page = { products: [{ id: 7001, handle: 'modern-sofa', title: 'Modern Sofa', vendor: 'Koala', images: [{ src: 'https://cdn.shopify.com/a.jpg?v=1' }] }, { id: 7002, handle: 'arch', title: 'Arch' }] };
  const url = shopifyListingUrl('https://shop.test', 'sofas', 2);
  expect(url).toBe('https://shop.test/collections/sofas/products.json?limit=250&page=2');
  const [listing] = await db.table('url').select('*');
  const category = db.addCategory('Sofas', '/collections/sofas', { ...(listing as any), site: { id: db.site.id } }, null);
  addShopifyListing(db, parseShopifyListing(JSON.stringify(page), url), {
    origin: 'https://shop.test', category, offset: 250, fromUrlId: Number(listing.id),
  });
  await db.flush();

  expect(await q(`select p.code, p.name, pc.position from product p join product_category pc on pc.product_id = p.id order by p.code`)).toEqual([
    { code: '7001', name: 'Modern Sofa', position: 251 },
    { code: '7002', name: 'Arch', position: 252 },
  ]);
  expect((await q(`select url from url where type = 'product' order by url`)).map((r) => r.url)).toEqual([
    'https://shop.test/products/arch',
    'https://shop.test/products/modern-sofa',
  ]);
  expect(await q('select count(*)::int as n from product_variant')).toEqual([{ n: 0 }]);
});

test('a product without options gets no placeholder axis', async () => {
  const single = {
    id: 9, title: 'Shampoo', handle: 'shampoo',
    options: [{ name: 'Title', values: ['Default Title'] }],
    variants: [{ id: 91, title: 'Default Title', option1: 'Default Title', price: 2995, available: true }],
  };
  addShopifyProduct(db, parseShopifyProduct(JSON.stringify(single), 'https://shop.test/products/shampoo.js'));
  await db.flush();
  expect(await q('select count(*)::int as n from product_attribute')).toEqual([{ n: 0 }]);
  expect(await q('select code, name, price::float from product_variant')).toEqual([{ code: '91', name: null, price: 29.95 }]);
});

test('option values no variant carries - a range\'s other products - are not this product\'s', async () => {
  const single = {
    id: 8, title: 'Devonshire Super White', handle: 'devonshire',
    options: [{ name: 'Colour', values: ['Super White', 'Seamist', 'Olive'] }, { name: 'Size', values: ['75x150', '150x150'] }],
    variants: [{ id: 81, title: 'Super White / 150x150', option1: 'Super White', option2: '150x150', price: 6250, available: true }],
  };
  addShopifyProduct(db, parseShopifyProduct(JSON.stringify(single), 'https://shop.test/products/devonshire.js'));
  await db.flush();
  expect(await q('select a.name, av.value, av.is_available from product_attribute a join product_attribute_value av on av.attribute_id = a.id order by a.sort_order')).toEqual([
    { name: 'Colour', value: 'Super White', is_available: true },
    { name: 'Size', value: '150x150', is_available: true },
  ]);
});

test('a pure rule flags each gallery image from its url and alt text', async () => {
  const json = parseShopifyProduct(JSON.stringify({
    ...PRODUCT,
    images: ['//cdn.shopify.com/s/files/1006828_000_001.png?v=1', '//cdn.shopify.com/s/files/1006828_Lifestyle_1.jpg?v=1', '//cdn.shopify.com/s/files/other.jpg'],
    media: [{ src: 'https://cdn.shopify.com/s/files/1006828_Lifestyle_1.jpg?v=1', alt: 'Kuni Grey - lifestyle view' }],
  }), 'https://shop.test/products/kuni.js');
  addShopifyProduct(db, json, {
    pure: (src, alt) => (/_000_\d+\./.test(src) ? true : alt?.includes('lifestyle') ? false : undefined),
  });
  await db.flush();
  expect(await q('select u.url, pi.pure from product_image pi join url u on u.id = pi.url_id order by pi.position')).toEqual([
    { url: 'https://cdn.shopify.com/s/files/1006828_000_001.png', pure: true },
    { url: 'https://cdn.shopify.com/s/files/1006828_Lifestyle_1.jpg', pure: false },
    { url: 'https://cdn.shopify.com/s/files/other.jpg', pure: null },
  ]);
});

test('bad records throw with their url, and the sitemap index splits by kind', async () => {
  expect(() => parseShopifyProduct('<html>', 'https://shop.test/products/x.js')).toThrow('https://shop.test/products/x.js is not JSON');
  expect(() => parseShopifyListing('{}', 'https://shop.test/l')).toThrow('has no products array');
  const index = `<?xml version="1.0"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
    <sitemap><loc>https://shop.test/sitemap_products_1.xml?from=1&amp;to=9</loc></sitemap>
    <sitemap><loc>https://shop.test/sitemap_pages_1.xml</loc></sitemap>
    <sitemap><loc>https://shop.test/sitemap_collections_1.xml</loc></sitemap></sitemapindex>`;
  expect(await shopifySitemaps(index)).toEqual({
    products: ['https://shop.test/sitemap_products_1.xml?from=1&to=9'],
    collections: ['https://shop.test/sitemap_collections_1.xml'],
  });
});
