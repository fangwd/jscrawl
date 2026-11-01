import { regressions, Snapshot } from '../src/core/snapshot';

const snapshot = (products: number, price: number, done: number, failed: number): Snapshot => ({
  takenAt: new Date(),
  products,
  fields: { price, availability: products, image: products, category: products, description: products, brand: products },
  pages: { done, failed },
});

test('a crawl as good as the last is no regression, and churn below the margins is not either', () => {
  expect(regressions(snapshot(1000, 990, 1000, 10), snapshot(1000, 990, 1000, 10))).toEqual([]);
  // 15% fewer products, 5 points more failing pages, 5 points fewer prices
  expect(regressions(snapshot(1000, 1000, 1000, 0), snapshot(850, 808, 950, 50))).toEqual([]);
});

test('a drop in products, a rise in failing pages and a field going missing are each named', () => {
  expect(regressions(snapshot(1000, 990, 1000, 10), snapshot(640, 380, 700, 300))).toEqual([
    'products fell from 1000 to 640 (-36%) since the last complete crawl',
    'failing product pages rose from 1% (10 of 1010) to 30% (300 of 1000)',
    'products with a price fell from 99% to 59%',
  ]);
});

test('a site too small for percentages to mean much is not judged on them', () => {
  expect(regressions(snapshot(8, 8, 8, 0), snapshot(2, 0, 2, 6))).toEqual([]);
});
