import { catalogueShortfalls, pageShortfalls, parseExpectations } from '../src/core/expect';

const table = (records: object[]) => ({ count: records.length, records });

test('expectations are checked when a crawler is registered', () => {
  expect(parseExpectations('shop', { products: [10, 20], fields: ['price', 'image'] })).toEqual({
    products: [10, 20],
    fields: ['price', 'image'],
  });
  expect(() => parseExpectations('shop', { products: [20, 10] })).toThrow(/min <= max/);
  expect(() => parseExpectations('shop', { products: 100 })).toThrow(/\[min, max\]/);
  expect(() => parseExpectations('shop', { fields: ['colour'] })).toThrow(/fields must list some of/);
  expect(() => parseExpectations('shop', { product: [1, 2] })).toThrow(/unknown keys: product/);
});

test('a product test page must carry the required fields it can carry', () => {
  const expectations = { fields: ['price', 'availability', 'image', 'category', 'description', 'brand'] as const };
  const full = {
    product: table([{ code: 'P1', description: 'Thin crust', brand: 'Pizzeria' }]),
    product_variant: table([{ price: 18, availability: 'in_stock' }]),
    product_image: table([{ url: 'https://shop.test/a.jpg' }]),
  };
  expect(pageShortfalls({ fields: [...expectations.fields] }, full)).toEqual([]);

  const bare = { product: table([{ code: 'P1', description: ' ' }]), product_variant: table([{ price: 0 }]) };
  // category comes from the listings that carry a product, so a product page is not asked for it
  expect(pageShortfalls({ fields: [...expectations.fields] }, bare)).toEqual([
    'no price', 'no availability', 'no image', 'no description', 'no brand',
  ]);
  // a page that saved no product (out of scope, vouched) is not checked
  expect(pageShortfalls({ fields: ['price'] }, {})).toEqual([]);
  expect(pageShortfalls(undefined, bare)).toEqual([]);
});

test('a crawled catalogue falls short on its count, or on a field below 95% of products', () => {
  const counts = (products: number, price: number) => ({
    products,
    fields: { price, availability: products, image: products, category: products, description: products, brand: products },
  });
  const expectations = { products: [40, 70] as [number, number], fields: ['price' as const] };
  expect(catalogueShortfalls(expectations, counts(52, 50))).toEqual([]);
  expect(catalogueShortfalls(expectations, counts(340, 200))).toEqual([
    '340 products were saved; the crawler expects 40-70',
    '140 of 340 products (41%) have no price; the crawler requires it on 95%',
  ]);
  expect(catalogueShortfalls(null, counts(0, 0))).toEqual([]);
});
