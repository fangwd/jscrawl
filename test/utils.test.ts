import { Database } from 'sqlex';

import { getUrlSite, trimTitle } from '../src/core/utils';

test('trimTitle', () => {
  expect(trimTitle(' foo  bar ')).toBe('foo bar');
  expect(trimTitle(' foo , bar  blah')).toBe('foo, bar blah');
});

const seeds = [
  { url: 'https://shop.test/au/', site: { name: 'shop-au' } },
  { url: 'https://www.shop.test/nz/', site: { name: 'shop-nz' } },
  { url: 'https://shop.test/nz/sale', site: { name: 'shop-nz-sale' } },
];
const database = (rows = seeds) =>
  ({ table: () => ({ select: async () => rows }) }) as unknown as Database;

test.each([
  ['https://shop.test/au/item', 'shop-au'],
  ['https://www.shop.test/au', 'shop-au'],
  ['https://shop.test/nz/item?sort=price#details', 'shop-nz'],
  ['https://www.shop.test/nz/', 'shop-nz'],
  ['https://shop.test/nz/sale/item', 'shop-nz-sale'],
  ['https://shop.test/nz/sales', 'shop-nz'],
])('getUrlSite selects the seed containing %s', async (url, name) => {
  await expect(getUrlSite(database(), url)).resolves.toBe(name);
});

test.each([
  'https://shop.test/austria/item',
  'https://shop.test/uk/item',
  'https://other.test/nz/item',
  'https://shop.test:8443/nz/item',
])('getUrlSite refuses an unrelated URL: %s', async (url) => {
  await expect(getUrlSite(database(), url)).rejects.toThrow(`Site not found for url: ${url}`);
});

test('getUrlSite prefers a regional seed over a root seed regardless of row order', async () => {
  const root = { url: 'https://shop.test/', site: { name: 'shop' } };
  for (const rows of [[root, ...seeds], [...seeds].reverse().concat(root)]) {
    await expect(getUrlSite(database(rows), 'https://shop.test/nz/item')).resolves.toBe('shop-nz');
    await expect(getUrlSite(database(rows), 'https://shop.test/help')).resolves.toBe('shop');
  }
});

test('getUrlSite ignores invalid saved seeds', async () => {
  const invalid = { url: 'not a URL', site: { name: 'invalid' } };
  await expect(
    getUrlSite(database([invalid, ...seeds]), 'https://shop.test/nz/item'),
  ).resolves.toBe('shop-nz');
});
