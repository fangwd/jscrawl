import { regressions, Snapshot } from '../src/core/snapshot';
import { testDomain } from './support/domain';

const snapshot = (pages: number, titled: number, done: number, failed: number): Snapshot => ({
  takenAt: new Date(),
  metrics: { pages, titled },
  pages: { done, failed },
});
const rules = testDomain.metricRules;

test('a crawl as good as the last is no regression, and churn below the margins is not either', () => {
  expect(regressions(snapshot(1000, 990, 1000, 10), snapshot(1000, 990, 1000, 10), rules)).toEqual([]);
  // 15% fewer pages, 5 points more failing pages, 5 points fewer titles
  expect(regressions(snapshot(1000, 1000, 1000, 0), snapshot(850, 808, 950, 50), rules)).toEqual([]);
});

test('a drop in a metric, a share falling and a rise in failing pages are each named', () => {
  expect(regressions(snapshot(1000, 990, 1000, 10), snapshot(640, 380, 700, 300), rules)).toEqual([
    'pages fell from 1000 to 640 (-36%) since the last complete crawl',
    'pages with a title fell from 99% to 59%',
    'failing pages rose from 1% (10 of 1010) to 30% (300 of 1000)',
  ]);
});

test('a site too small for percentages to mean much is not judged on them', () => {
  expect(regressions(snapshot(8, 8, 8, 0), snapshot(2, 0, 2, 6), rules)).toEqual([]);
});
