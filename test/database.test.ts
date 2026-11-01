import { readFileSync } from 'fs';
import { parse } from 'gumbo-html';
import { CrawlerDatabase } from '../src/core/database';
import { jsonLd, productFromJsonLd } from '../src/core/extract';
import { SiteUrl, UrlStatus } from '../src/core/models';

const connection = {
  dialect: 'postgres' as const,
  connection: {
    host: '127.0.0.1',
    port: 5434,
    user: 'admin',
    password: 'secret',
    database: 'jscrawl_test',
  },
};

let db: CrawlerDatabase;
let seed: SiteUrl;

beforeAll(async () => {
  db = new CrawlerDatabase(connection);
  await db.buildSchema();
});

afterAll(() => db.end());

beforeEach(async () => {
  await db.zap();
  const crawler = db.table('crawler').append({ name: 'shop' });
  const site = db.table('site').append({ name: 'shop', crawler, currency: 'AUD' });
  db.table('url').append({ site, url: 'https://shop.test/', hash: 'seed', type: 'seed' });
  await db.flush();
  db.clear();
  await db.init('shop');
  seed = (await db.table('url').select({ site: '*' }))[0] as unknown as SiteUrl;
});

const rows = (table: string, where = {}) =>
  db.table(table).select('*', { where, orderBy: ['id'] }) as Promise<any[]>;

// select('*') expands foreign keys to id-only records; ask for the group name
const attrRows = () =>
  db.table('product_attribute').select({ group: { fields: ['name'] } }, { orderBy: ['id'] }) as Promise<any[]>;

test('top level categories are upserted by name', async () => {
  for (let i = 0; i < 2; i++) {
    const tiles = db.addCategory('Tiles', '/tiles', seed, null);
    db.addCategory('Floor', '/tiles/floor', seed, tiles);
    await db.flush();
    db.clear();
  }
  const categories = await rows('category');
  expect(categories.map((c) => c.name)).toEqual(['Tiles', 'Floor']);
  expect(categories[1].parent.id).toBe(categories[0].id);
});

test('a category re-referenced after a flush updates its row', async () => {
  db.addCategory('Tiles', '/tiles', seed, null);
  await db.flush();
  db.clear();
  const [stored] = await rows('category');

  // A later page re-references the category. The buffered record must already
  // know its row: a flush matches records by their unique key before the url
  // they reference has an id, so an insert here duplicates `category.url_id`.
  const again = db.addCategory('Ceramic Tiles', '/tiles', seed, null);
  expect(again!.id).toBe(stored.id);
  await db.flush();
  db.clear();

  const categories = await rows('category');
  expect(categories).toHaveLength(1);
  expect(categories[0]).toMatchObject({ id: stored.id, name: 'Ceramic Tiles' });
});

test("the product page's category is the product's one primary category", async () => {
  const sale = db.addCategory('Sale', '/sale', seed, null);
  const sofas = db.addCategory('Sofas', '/sofas', seed, null);
  const primary = async () => {
    await db.flush();
    db.clear();
    const memberships = await db.query<any[]>(
      'select c.name, pc.is_primary from product_category pc join category c on c.id = pc.category_id order by c.name'
    );
    return Object.fromEntries(memberships.map((m) => [m.name, m.is_primary]));
  };

  db.addProduct({ code: 'P1' }, { category: sale, position: 3 });
  db.addProduct({ code: 'P1' }, { category: sofas, detailed: true });
  expect(await primary()).toEqual({ Sale: false, Sofas: true });

  // re-filed by its own page; a listing seen later does not take the flag back
  db.addProduct({ code: 'P1' }, { category: db.addCategory('Beds', '/beds', seed, null), detailed: true });
  db.addProduct({ code: 'P1' }, { category: db.addCategory('Sofas', '/sofas', seed, null), position: 1 });
  expect(await primary()).toEqual({ Beds: true, Sale: false, Sofas: false });
});

test('a trail that ends in the category itself does not make it its own parent', async () => {
  const trail = db.addCategoryPath([{ name: 'Shop', url: '/shop' }, { name: 'Scooters', url: '/shop/scooters' }], seed);
  db.addCategory('Electric scooters', '/shop/scooters', seed, trail);
  await db.flush();
  db.clear();

  const [shop, scooters] = await rows('category');
  expect(scooters).toMatchObject({ name: 'Electric scooters', parent: { id: shop.id } });
});

test.each([undefined, null, 42, { name: 'Small' }, { value: 42 }])('invalid attribute value %p fails before adding records', (entry) => {
  const product = db.addProduct({ code: 'P1' });
  expect(() => db.addAttribute(product, { name: 'Size', values: ['Small', entry] as any })).toThrow(
    /Attribute "Size" values\[1\] must be a string or \{ value: string \}.*Check the source JSON shape/
  );
  for (const table of ['product_attribute_group', 'product_attribute', 'product_attribute_value']) {
    expect(db.table(table).recordList).toHaveLength(0);
  }
  const { attribute, values } = db.addAttribute(product, { name: 'Size', values: ['Large'] });
  expect(attribute.get('sortOrder')).toBe(0);
  expect(values[0].get('value')).toBe('Large');
});

test('product with variant price, attributes and images', async () => {
  const product = db.addProduct(
    { code: 'P1', name: '  Pad  Thai ', brand: 'Thai Co', structuredData: { '@type': 'Product' } },
    { detailed: true }
  );
  const { values } = db.addAttribute(product, {
    name: 'Spice',
    minSelect: 1,
    maxSelect: 1,
    values: ['Mild', { value: 'Hot', priceDelta: 1.5 }],
  });
  db.addAttribute(product, { groupName: 'Details', name: 'Origin', values: ['Bangkok'] });
  db.addVariant(product, { price: 12.5, unit: 'each' });
  const large = db.addVariant(product, { code: 'L', price: 15 }, [values[1]]);
  const small = db.addVariant(product, { code: 'S', availability: 'out_of_stock' }, [values[0]]);
  db.addProductImage(product, 'https://shop.test/a.jpg');
  db.addProductImage(product, 'https://shop.test/b.jpg');
  db.addProductImage(product, 'https://shop.test/swatch.jpg', 'swatch', [large]);
  db.addProductImage(product, 'https://shop.test/swatch.jpg', 'swatch', [small]);
  await db.flush();

  const [p] = await rows('product');
  expect(p.name).toBe('Pad Thai');
  expect(p.structuredData).toEqual({ '@type': 'Product' });
  expect((await rows('brand'))[0].name).toBe('Thai Co');

  const attributes = await attrRows();
  expect(attributes.map((a) => [a.group.name, a.name, a.sortOrder])).toEqual([
    ['', 'Spice', 0],
    ['Details', 'Origin', 1],
  ]);
  const hot = (await rows('product_attribute_value', { value: 'Hot' }))[0];
  expect(Number(hot.priceDelta)).toBe(1.5);
  expect(hot.isAvailable).toBeNull();

  // the site's order is kept in sort_order; ids follow the order rows are written in
  const variants = (await rows('product_variant')).sort((a, b) => a.sortOrder - b.sortOrder);
  expect(variants.map((v) => v.sortOrder)).toEqual([0, 1, 2]);
  expect(variants.map((v) => [v.code, v.price && Number(v.price), v.availability])).toEqual([
    ['', 12.5, null],
    ['L', 15, null],
    ['S', null, 'out_of_stock'],
  ]);
  const prices = await db.query<any[]>(
    'select p.currency, p.availability from variant_price p join product_variant v on v.id = p.variant_id order by v.sort_order'
  );
  expect(prices.map((p) => [p.currency, p.availability])).toEqual([
    ['AUD', null],
    ['AUD', null],
    ['AUD', 'out_of_stock'],
  ]);
  const [largeValue] = await db.query<any[]>(
    "select vv.attribute_value_id from product_variant_value vv join product_variant v on v.id = vv.variant_id where v.code = 'L'"
  );
  expect(Number(largeValue.attribute_value_id)).toBe(Number(hot.id));

  const images = (await rows('product_image')).sort((a, b) => a.position - b.position);
  expect(images.map((i) => [i.role, i.position])).toEqual([
    ['gallery', 0],
    ['gallery', 1],
    ['swatch', 3],
  ]);
  const swatchVariants = await rows('product_image_variant');
  expect(swatchVariants.map((v) => v.variant.id).sort()).toEqual(
    variants.slice(1).map((v) => v.id).sort()
  );
});

test('variants only take one value per attribute of their own product', () => {
  const product = db.addProduct({ code: 'P1' });
  const other = db.addProduct({ code: 'P2' });
  const { values } = db.addAttribute(product, { name: 'Size', values: ['S', 'L'] });
  const { values: otherValues } = db.addAttribute(other, { name: 'Size', values: ['S'] });
  const otherVariant = db.addVariant(other, { code: 'S' }, otherValues);

  expect(() => db.addVariant(product, { code: 'X' }, otherValues)).toThrow(/another product/);
  expect(() => db.addVariant(product, { code: 'X' }, values)).toThrow(/two values for Size/);
  expect(() => db.addProductImage(product, 'https://shop.test/x.jpg', 'swatch', [otherVariant])).toThrow(/another product/);
  db.clear();
});

test('stale busy urls are reclaimed', async () => {
  const claimed = await db.claimUrl();
  expect(claimed!.id).toBe(seed.id);
  expect(await db.claimUrl()).toBeNull();

  await db.table('url').update({ claimedAt: new Date(Date.now() - 60 * 60 * 1000) }, { id: seed.id });
  expect((await db.claimUrl())!.id).toBe(seed.id);
});

test('a link that is not a fetchable url is not queued', async () => {
  expect(db.addUrl('mailto:sales@shop.test', 'product', null)).toBeNull();
  expect(db.addUrl('tel:+611800000000', 'product', null)).toBeNull();
  expect(db.addUrl('javascript:void(0)', 'product', null)).toBeNull();
  // A site's typo'd scheme, which the parser reads as a url with protocol ttps:
  expect(db.addUrl('ttps://shop.test/shop-by-type/ceramic', 'category', null)).toBeNull();
  expect(db.addUrl('', 'product', null)).toBeNull();
  db.addUrl('https://shop.test/real', 'product', null);
  await db.flush();
  expect(await rows('url')).toHaveLength(2);
});

test('urls the path rules disallow are recorded, never claimed', async () => {
  await db.table('crawler').update({ allow: ['/shop/fruit'], disallow: ['/shop/'] }, { name: 'shop' });
  await db.init('shop');
  db.addUrl('https://shop.test/shop/fruit/apples', 'category', seed.id);
  db.addUrl('https://shop.test/shop/dairy', 'category', seed.id);
  db.addUrl('https://shop.test/shop/milk', 'product', seed.id);
  db.addUrl('https://cdn.test/shop/dairy.jpg', 'image', null);
  await db.flush();

  const status = Object.fromEntries((await rows('url')).map((url) => [url.url, url.status]));
  expect(status).toEqual({
    'https://shop.test/': UrlStatus.Idle,
    'https://shop.test/shop/fruit/apples': UrlStatus.Idle,
    'https://shop.test/shop/dairy': UrlStatus.Disallowed,
    'https://shop.test/shop/milk': UrlStatus.Disallowed,
    'https://cdn.test/shop/dairy.jpg': UrlStatus.Idle,
  });
  const claimed = [await db.claimUrl({ type: ['seed', 'category', 'product'] }), await db.claimUrl({ type: ['seed', 'category', 'product'] })];
  expect(claimed.map((url) => url!.url).sort()).toEqual(['https://shop.test/', 'https://shop.test/shop/fruit/apples']);
  expect(await db.claimUrl({ type: ['seed', 'category', 'product'] })).toBeNull();
});

test('retyping the page being scraped persists, claimed row and all', async () => {
  db.addUrl('https://shop.test/shop-tiles', 'product', null);
  await db.flush();
  db.clear();

  // The crawler's own flow: claim the row (which tracks it in this session),
  // scrape it, discover it is a listing, correct its type - and then the core
  // records the scrape on the same row (src/core/crawler.ts).
  const claimed = await db.claimUrl({ type: 'product' });
  expect(claimed!.url).toBe('https://shop.test/shop-tiles');
  db.retypeUrl(claimed!, 'category');
  // The record the crawl holds must change too: validate() runs on it, and a
  // category checked as a product escalates a page that saved 20 products.
  expect(claimed!.type).toBe('category');
  db.table('url').append({ id: claimed!.id, status: 2, version: claimed!.version + 1 });
  await db.flush();
  db.clear();

  const [row] = await rows('url', { url: 'https://shop.test/shop-tiles' });
  expect(row.type).toBe('category');
  expect(await rows('url')).toHaveLength(2);
});

test('a link queued from another page does not revert a corrected type', async () => {
  db.addUrl('https://shop.test/shop-tiles', 'product', null);
  await db.flush();
  db.clear();

  const claimed = await db.claimUrl({ type: 'product' });
  db.retypeUrl(claimed!.url, 'category');
  db.table('url').append({ id: claimed!.id, status: 2, version: claimed!.version + 1 });
  await db.flush();
  db.clear();

  // Every page links to the menu's categories, so the next page the crawler
  // scrapes queues this url again and guesses 'product' from its shape again.
  db.addUrl('https://shop.test/shop-tiles', 'product', null);
  await db.flush();
  const [row] = await rows('url', { url: 'https://shop.test/shop-tiles' });
  expect(row.type).toBe('category');

  // And a later crawl process reads the correction from the database.
  const later = new CrawlerDatabase(connection);
  await later.init('shop');
  later.addUrl('https://shop.test/shop-tiles', 'product', null);
  await later.flush();
  await later.end();
  expect((await rows('url', { url: 'https://shop.test/shop-tiles' }))[0].type).toBe('category');
});

test('a mis-typed url is retyped in place, not re-queued or duplicated', async () => {
  db.addUrl('https://shop.test/pavers', 'product', seed.id);
  await db.flush();
  db.clear();
  const queued = (await rows('url', { url: 'https://shop.test/pavers' }))[0];
  expect(queued.type).toBe('product');

  // The crawler scraped it, found a listing rather than a product, and retypes it.
  await db.table('url').update({ status: 2 }, { id: queued.id });
  db.retypeUrl('https://shop.test/pavers', 'category');
  await db.flush();

  const [retyped] = await rows('url', { url: 'https://shop.test/pavers' });
  expect(retyped.type).toBe('category');
  expect(retyped.status).toBe(2);
  expect(await rows('url')).toHaveLength(2);
});

test('a detail page replaces images and variants; what it keeps keeps its id and price history', async () => {
  // the page offers sizes S and M, an image per size and a gallery shot
  const detail = (sizes: string[], images: { src: string; size?: string }[]) => {
    const product = db.addProduct({ code: 'P1' }, { detailed: true });
    const { values } = db.addAttribute(product, { name: 'Size', values: sizes });
    const variants = new Map(sizes.map((size, i) => [size, db.addVariant(product, { code: size, price: 10 + i }, [values[i]])]));
    for (const { src, size } of images) db.addProductImage(product, src, 'gallery', size ? [variants.get(size)!] : []);
  };
  detail(['S', 'M'], [{ src: 'https://cdn.test/s.jpg', size: 'S' }, { src: 'https://cdn.test/m.jpg', size: 'M' }, { src: 'https://cdn.test/old.jpg?w=700' }]);
  await db.flush();
  db.clear();
  const [small] = await rows('product_variant', { code: 'S' });
  await new Promise((resolve) => setTimeout(resolve, 5));

  // the site drops M and its image, and serves the gallery shot at its own url
  detail(['S'], [{ src: 'https://cdn.test/s.jpg', size: 'S' }, { src: 'https://cdn.test/old.jpg' }]);
  await db.flush();
  db.clear();

  const variants = await rows('product_variant');
  expect(variants.map((v) => [v.code, v.id])).toEqual([['S', small.id]]);
  expect(await rows('variant_price', { variant: { id: small.id } })).toHaveLength(2);
  expect(await rows('variant_price')).toHaveLength(2);
  const images = await db.query<{ url: string; variants: number }[]>(
    `select u.url, count(iv.id)::int as variants from product_image pi join url u on u.id = pi.url_id
       left join product_image_variant iv on iv.image_id = pi.id group by u.url order by u.url`
  );
  expect(images).toEqual([
    { url: 'https://cdn.test/old.jpg', variants: 0 },
    { url: 'https://cdn.test/s.jpg', variants: 1 },
  ]);
  expect(await rows('product_variant_value')).toHaveLength(1);
});

test('detail page replaces attributes; listing page does not', async () => {
  const detail = (attributes: string[]) => {
    const product = db.addProduct({ code: 'P1' }, { detailed: true });
    for (const name of attributes) {
      db.addAttribute(product, { name, values: ['x'] });
    }
  };

  detail(['Colour', 'Size']);
  await db.flush();
  db.clear();

  const category = db.addCategory('Tiles', '/tiles', seed, null);
  db.addProduct({ code: 'P1', name: 'Listed' }, { category });
  await db.flush();
  db.clear();
  expect(await rows('product_attribute')).toHaveLength(2);
  expect(await rows('product_category')).toHaveLength(1);

  detail(['Colour']);
  await db.flush();
  db.clear();
  const attributes = await rows('product_attribute');
  expect(attributes.map((a) => a.name)).toEqual(['Colour']);
  expect(await rows('product_attribute_value')).toHaveLength(1);
  expect(await rows('product_category')).toHaveLength(1);
});

test('products at a missing url are marked gone', async () => {
  const product = db.addProduct({ code: 'P1' });
  const productUrl = db.addProductUrl(product, 'https://shop.test/p1', seed.id);
  await db.flush();
  db.clear();

  await db.markProductsGone((productUrl!.url as any).id);
  expect((await rows('product'))[0].status).toBe('gone');
  expect(await rows('url_graph')).toHaveLength(1);
});

test('breadcrumb paths become a category chain', async () => {
  const page = { ...seed, url: 'https://shop.test/tiles/floor/p1' };
  const leaf = db.addCategoryPath(
    [
      { name: 'Home', url: 'https://shop.test/' },
      { name: 'Tiles', url: '/tiles' },
      { name: 'Shop by look' },
      { name: 'Floor', url: '/tiles/floor#top' },
      { name: 'Floor again', url: '/tiles/floor' },
      { name: 'Nordic tile', url: 'https://shop.test/tiles/floor/p1' },
    ],
    page
  );
  db.addProduct({ code: 'P1' }, { category: leaf });
  await db.flush();

  const categories = await rows('category');
  expect(categories.map((c) => c.name)).toEqual(['Tiles', 'Floor']);
  expect(categories[1].parent.id).toBe(categories[0].id);
  expect((await rows('product_category'))[0].category.id).toBe(categories[1].id);
  expect(db.addCategoryPath([{ name: 'Home', url: '/' }], page)).toBeNull();
});

test('a crumb to the page itself is no category, though the page carries extra query', () => {
  const variant = { ...seed, url: 'https://shop.test/products/kuni?variant=52' };
  expect(db.addCategoryPath([{ name: 'Kuni', url: 'https://shop.test/products/kuni' }], variant)).toBeNull();
  // a query that names another category keeps it
  const listing = { ...seed, url: 'https://shop.test/catalog?cat=12&page=2' };
  const leaf = db.addCategoryPath(
    [{ name: 'Tiles', url: '/catalog?cat=5' }, { name: 'Floor', url: '/catalog?cat=12' }],
    listing
  );
  expect(leaf!.get('name')).toBe('Tiles');
  db.clear();
});

test('menus become a category tree', async () => {
  db.addCategoryTree(
    [
      {
        name: 'Tiles',
        url: '/tiles',
        children: [
          { name: 'Browse by', children: [{ name: 'Floor', url: '/tiles/floor' }] },
          { name: 'Wall', url: '/tiles/wall' },
        ],
      },
    ],
    seed
  );
  await db.flush();

  const categories = await rows('category');
  expect(categories.map((c) => [c.name, c.parent?.id ?? null])).toEqual([
    ['Tiles', null],
    ['Floor', categories[0].id],
    ['Wall', categories[0].id],
  ]);
});

test('flush errors name the buffered records', async () => {
  db.table('product').append({ site: 99999, code: 'BROKEN' });
  await expect(db.flush()).rejects.toThrow(/flushing: .*product: 1 \[BROKEN\]/);
  db.clear();
});

test('spec pairs become attributes in a group', async () => {
  const product = db.addProduct({ code: 'P1' });
  db.addSpecs(product, [{ name: 'Material', value: 'Concrete' }, { name: 'Shape', value: 'Round' }], 'Specification');
  await db.flush();

  const attributes = await attrRows();
  expect(attributes.map((a) => [a.group.name, a.name])).toEqual([
    ['Specification', 'Material'],
    ['Specification', 'Shape'],
  ]);
  expect((await rows('product_attribute_value')).map((v) => v.value)).toEqual(['Concrete', 'Round']);
});

test('attribute groups are created once per product with their own sort order', async () => {
  const product = db.addProduct({ code: 'G1' }, { detailed: true });
  db.addAttribute(product, { groupName: 'Specs', name: 'Material', values: ['Brass'] });
  db.addAttribute(product, { groupName: 'Specs', name: 'Finish', values: ['Chrome'] });
  db.addAttribute(product, { name: 'Note', values: ['root level'] });
  await db.flush();

  // a group's place is its sort_order; ids follow the order rows are written in
  const groups = (await rows('product_attribute_group')).sort((a, b) => a.sortOrder - b.sortOrder);
  expect(groups.map((g) => [g.name, g.sortOrder])).toEqual([
    ['Specs', 0],
    ['', 1],
  ]);
  const attrs = (await attrRows()).sort((a, b) => a.sortOrder - b.sortOrder);
  expect(attrs.map((a) => [a.group.name, a.name])).toEqual([
    ['Specs', 'Material'],
    ['Specs', 'Finish'],
    ['', 'Note'],
  ]);

  // a detailed re-scrape replaces the groups with the page's current sections
  db.clear();
  const again = db.addProduct({ code: 'G1' }, { detailed: true });
  db.addAttribute(again, { groupName: 'Other', name: 'Weight', values: ['1kg'] });
  await db.flush();
  expect((await rows('product_attribute_group')).map((g) => g.name)).toEqual(['Other']);
});

test('extracted product data is saved with variants, axes and images', async () => {
  const doc = parse(readFileSync('test/fixtures/ideal-bathroom-product.html', 'utf8'));
  db.addProductData(productFromJsonLd(jsonLd(doc))!, { detailed: true });
  db.addProductData(
    {
      product: { name: 'Tile' },
      attributes: [{ name: 'Size', values: ['Small', 'Large'] }],
      variants: [
        { code: 'S', price: 10, values: { Size: 'Small' } },
        { code: 'L', price: 12, values: { Size: 'Large' } },
      ],
      images: [],
    },
    { code: 'T1' }
  );
  await db.flush();

  const [milano] = await rows('product', { code: '9714724798695' });
  const [tile] = await rows('product', { code: 'T1' });
  expect(milano.name).toBe('Milano Cerchio Concrete 380mm Above Counter Basin, Tan Brown');
  expect(milano.structuredData['@type']).toBe('ProductGroup');
  expect(tile.name).toBe('Tile');
  expect((await rows('brand'))[0].name).toBe('Milano');
  expect(await rows('product_image', { product: milano.id })).toHaveLength(3);

  const [basin] = await rows('product_variant', { product: milano.id });
  expect([basin.code, Number(basin.price), basin.availability]).toEqual(['BA-CER383810TB', 326.55, 'in_stock']);

  const sizes = await db.table('product_variant_value').select(
    { variant: { fields: ['code', 'price'] }, attributeValue: { fields: ['value'] } },
    { where: { variant: { product: tile.id } } }
  ) as any[];
  expect(sizes.map((s) => [s.variant.code, Number(s.variant.price), s.attributeValue.value]).sort()).toEqual([
    ['L', 12, 'Large'],
    ['S', 10, 'Small'],
  ]);
  expect(() => db.addProductData({ product: {}, attributes: [], variants: [], images: [] })).toThrow(/no code/);
  db.clear();
});
