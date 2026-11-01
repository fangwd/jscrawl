import { CrawlerDatabase } from '../src/core/database';
import { exportFeed } from '../src/core/feed';
import { SiteUrl } from '../src/core/models';

const connection = {
  dialect: 'postgres' as const,
  connection: { host: '127.0.0.1', port: 5434, user: 'admin', password: 'secret', database: 'jscrawl_test' },
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

/** The rows of a CSV file as objects; enough of RFC 4180 for the exporter's output. */
function readCsv(text: string): { [column: string]: string }[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') (cell += '"'), i++;
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') row.push(cell), (cell = '');
    else if (c === '\n') row.push(cell), rows.push(row), (row = []), (cell = '');
    else cell += c;
  }
  const [header, ...body] = rows;
  return body.map((r) => Object.fromEntries(header.map((name, i) => [name, r[i]])));
}

test('a row leads with pictures of the product alone and carries at most five', async () => {
  const tile = db.addProduct({ code: 'T1', name: 'Kuni' });
  db.addVariant(tile, { price: 70 });
  // the site's first picture is a room; its plain faces come later
  db.addProductImage(tile, 'https://cdn.test/room.jpg', 'thumbnail', [], false);
  db.addProductImage(tile, 'https://cdn.test/unjudged.jpg', 'gallery');
  for (const n of [1, 2, 3, 4, 5]) db.addProductImage(tile, `https://cdn.test/face-${n}.jpg`, 'gallery', [], true);
  await db.flush();
  db.clear();

  const [row] = readCsv((await exportFeed(db, 'shop')).products);
  expect(row.image_link).toBe('https://cdn.test/face-1.jpg');
  expect(row.additional_image_link.split(',')).toEqual([2, 3, 4, 5].map((n) => `https://cdn.test/face-${n}.jpg`));
});

test('a catalogue exports as products and categories files for the feed import', async () => {
  const menu = db.addCategory('Pizzas', '/pizzas', seed, null, {
    description: 'Wood-fired, "72 hrs" dough',
    image: 'https://cdn.test/pizzas.jpg',
    sortOrder: 2,
  });
  const reds = db.addCategory('Reds', '/pizzas/reds', seed, menu, { sortOrder: 1 });

  const pizza = db.addProduct({ code: 'P1', name: 'Margherita', description: 'Tomato, basil' }, { category: reds, position: 3 });
  const { values: sizes } = db.addAttribute(pizza, { name: 'Size', values: ['Small', 'Large'] });
  db.addVariant(pizza, { code: 's', price: 18, availability: 'in_stock' }, [sizes[0]]);
  const largeVariant = db.addVariant(pizza, { code: 'l', price: 20, compareAtPrice: 24, availability: 'out_of_stock' }, [sizes[1]]);
  db.addAttribute(pizza, {
    groupName: 'Options',
    name: 'Extras',
    maxSelect: 3,
    allowQuantity: true,
    values: [
      { value: 'Cheese', priceDelta: 2 },
      { value: 'Olives', priceDelta: 1.5, isAvailable: false },
    ],
  });
  db.addAttribute(pizza, { groupName: 'Tags', name: 'Tag', values: ['Vegetarian', 'Halal'] });
  db.addProductImage(pizza, 'https://cdn.test/p1.jpg', 'thumbnail');
  // a swatch is never the main picture, even ahead of the variant's photo
  db.addProductImage(pizza, 'https://cdn.test/large-swatch.jpg', 'swatch', [largeVariant]);
  db.addProductImage(pizza, 'https://cdn.test/p1-large.jpg', 'gallery', [largeVariant]);
  await db.flush();
  db.clear();

  const feed = await exportFeed(db, 'shop');
  expect(feed).toMatchObject({
    productCount: 1, skippedCount: 0, rowCount: 2, categoryCount: 2,
    gaps: { rowsWithoutPrice: 0, rowsWithoutAvailability: 0, productsWithoutImage: 0, productsWithoutCategory: 0 },
  });

  const [small, large] = readCsv(feed.products);
  expect(small).toMatchObject({
    id: 'P1-s',
    item_group_id: 'P1',
    title: 'Margherita',
    price: '18.0000 AUD',
    sale_price: '',
    availability: 'in_stock',
    product_type: 'Pizzas > Reds',
    category_position: '3',
    image_link: 'https://cdn.test/p1.jpg',
    variant_options: 'Size:Small',
  });
  expect(JSON.parse(small.option_groups)).toEqual([
    {
      code: 'Extras',
      name: 'Extras',
      min_select: 0,
      max_select: 3,
      // sold-out Olives are left out
      values: [{ code: 'Cheese', label: 'Cheese', price_extra: '2.0000', is_default: false }],
    },
  ]);
  expect(JSON.parse(small.product_attributes)).toEqual({ Tag: 'Vegetarian, Halal' });
  // product-level columns only on the group's first row; the sale shows as price + sale_price
  expect(large).toMatchObject({
    id: 'P1-l', item_group_id: 'P1', title: '', option_groups: '', price: '24.0000 AUD', sale_price: '20.0000 AUD',
    availability: 'out_of_stock', variant_options: 'Size:Large',
    image_link: 'https://cdn.test/p1-large.jpg',
    additional_image_link: 'https://cdn.test/p1.jpg,https://cdn.test/large-swatch.jpg',
  });
  expect(small.additional_image_link).toBe('');

  // a product with a variant but no price, availability, image or category
  const bare = db.addProduct({ code: 'P2', name: 'Calzone' });
  db.addVariant(bare, {});
  await db.flush();
  db.clear();
  expect((await exportFeed(db, 'shop')).gaps).toEqual({
    rowsWithoutPrice: 1, rowsWithoutAvailability: 1, productsWithoutImage: 1, productsWithoutCategory: 1,
  });

  expect(readCsv(feed.categories)).toEqual([
    { product_type: 'Pizzas', description: 'Wood-fired, "72 hrs" dough', image_link: 'https://cdn.test/pizzas.jpg', sort_order: '2' },
    { product_type: 'Pizzas > Reds', description: '', image_link: '', sort_order: '1' },
  ]);
});
