// A crawler's url classifier against the site's own pages, before any crawl:
// sample urls of each shape, ask urlType() what it would queue them as, fetch
// them and ask pageKind() what the page says it is. A crawl only reveals a
// mistyped or dropped shape after it has cost the pages; this costs a few.

import { parse, XDocument } from 'gumbo-html';

import { urlShape } from './coverage';
import { SurveyShape } from './survey';

export interface ClassifiedPage {
  url: string;
  shape: string;
  /** What urlType() queues it as; null drops it. Undefined when the crawler does not type urls by their shape. */
  queuedAs?: string | null;
  /** What pageKind() says the fetched page is; undefined when it could not be asked. */
  pageKind?: string;
  status?: number;
  /** What is wrong, when something is. */
  problem?: string;
  /** Why the page was not fetched, when a crawl would not fetch it either. */
  skipped?: string;
}

/**
 * How a crawler classifies. urlType() is given the full url and drops it with null
 * or undefined; a crawler that queues links by where it finds them has none.
 * pageKind() names the domain's types and otherwise the crawler's own kinds; a
 * page it does not recognise is the template's 'unknown', or a throw.
 */
export interface Classifier {
  urlType?(href: string): string | null | undefined;
  pageKind(doc: XDocument): string | undefined;
}

/** What the template's pageKind() returns for a page no marker recognises. */
const UNRECOGNISED = 'unknown';

const NAMES = ['classifier', 'urlType', 'pageKind'];

/**
 * A crawler's classifier: the urlType() and pageKind() the template declares, or
 * what its classifier() returns - how a shared profile, whose own rules have other
 * names, says how it classifies. The class nearest the crawler decides, so a site
 * that classifies for itself is checked on its own rules, not its profile's.
 */
export function classifierOf(crawler: any): {
  classifier: Classifier;
  from: 'its own urlType() and pageKind()' | 'its classifier()';
} {
  let nearest: object | null = Object.getPrototypeOf(crawler);
  while (nearest && !NAMES.some((name) => Object.hasOwn(nearest!, name)))
    nearest = Object.getPrototypeOf(nearest);
  const declared = typeof crawler.urlType === 'function' && typeof crawler.pageKind === 'function';
  const explicit = typeof crawler.classifier === 'function';
  if (explicit && (!declared || (nearest && Object.hasOwn(nearest, 'classifier')))) {
    return { classifier: crawler.classifier(), from: 'its classifier()' };
  }
  if (declared) {
    return {
      classifier: {
        urlType: (href) => crawler.urlType(href),
        pageKind: (doc) => crawler.pageKind(doc),
      },
      from: 'its own urlType() and pageKind()',
    };
  }
  throw new Error(
    'The crawler has neither urlType() and pageKind(), as the template declares them, nor a classifier(): the check has nothing to ask',
  );
}

/** Up to `perShape` sample urls of each shape, `limit` in all, biggest shapes first. */
export function sampleUrls(shapes: SurveyShape[], perShape: number, limit: number): string[] {
  const urls: string[] = [];
  const sampled = new Set<string>();
  for (const group of shapes) {
    // a shape both the sitemaps and the home page have is sampled once
    if (sampled.has(group.shape)) continue;
    sampled.add(group.shape);
    for (const url of group.samples.slice(0, perShape)) {
      if (urls.length < limit && !urls.includes(url)) urls.push(url);
    }
  }
  return urls;
}

/** A page as the crawl would fetch it, or why the crawl would not (robots.txt disallows it). */
export type PageFetcher = (
  url: string,
) => Promise<{ status: number; html: string; url: string } | { skipped: string }>;

/**
 * Classifies each url twice - by its shape and by its page - and says where the
 * two disagree. `types` are the page types that carry records; `before` runs
 * ahead of each call of the crawler's, which may read the url it is on.
 */
export async function checkClassifier(
  classifier: Classifier,
  urls: string[],
  types: readonly string[],
  fetchPage: PageFetcher,
  before: (url: string, queuedAs: string | null) => void = () => {},
): Promise<ClassifiedPage[]> {
  const pages: ClassifiedPage[] = [];
  for (const url of urls) {
    const page: ClassifiedPage = { url, shape: urlShape(url) };
    pages.push(page);
    try {
      before(url, null);
      if (classifier.urlType) page.queuedAs = classifier.urlType(url) ?? null;
    } catch (err: any) {
      page.problem = `urlType() threw: ${err?.message ?? err}`;
      continue;
    }
    let fetched: Awaited<ReturnType<PageFetcher>>;
    try {
      fetched = await fetchPage(url);
    } catch (err: any) {
      page.problem = `could not be fetched: ${err?.message ?? err}`;
      continue;
    }
    if ('skipped' in fetched) {
      page.skipped = fetched.skipped;
      continue;
    }
    page.status = fetched.status;
    if (fetched.status >= 400) {
      page.problem = `HTTP ${fetched.status}`;
      continue;
    }
    try {
      before(fetched.url, page.queuedAs ?? null);
      page.pageKind =
        classifier.pageKind(parse(fetched.html, { baseUrl: fetched.url })) ?? UNRECOGNISED;
    } catch {
      // a pageKind() that throws on a page it does not recognise says the same as one returning 'unknown'
      page.pageKind = UNRECOGNISED;
    }
    const carries = types.includes(page.pageKind);
    if (page.queuedAs === undefined) continue;
    if (page.queuedAs === null && carries) {
      page.problem = `dropped, but the page is a ${page.pageKind}: urlType() misses this shape`;
    } else if (page.queuedAs !== null && page.pageKind === UNRECOGNISED) {
      page.problem = `queued as ${page.queuedAs}, but pageKind() does not recognise the page: its scrape would throw`;
    } else if (page.queuedAs !== null && carries && page.queuedAs !== page.pageKind) {
      page.problem = `queued as ${page.queuedAs}, but the page is a ${page.pageKind}: retyped at scrape time, or a wrong rule`;
    }
  }
  return pages;
}

export function renderClassified(pages: ClassifiedPage[], from?: string): string {
  const lines: string[] = from ? [`classified by ${from}`] : [];
  const typed = pages.some((page) => page.queuedAs !== undefined);
  const shapes = [...new Set(pages.map((page) => page.shape))];
  for (const shape of shapes) {
    lines.push(shape);
    for (const page of pages.filter((p) => p.shape === shape)) {
      lines.push(`  ${page.url}`);
      const outcome = page.skipped
        ? `not fetched: ${page.skipped}`
        : `pageKind: ${page.pageKind ?? '-'}`;
      const queued = page.queuedAs === undefined ? '-' : (page.queuedAs ?? 'null (dropped)');
      lines.push(
        `      urlType: ${queued} | ${outcome}${page.problem ? ` | PROBLEM: ${page.problem}` : ''}`,
      );
    }
  }
  const problems = pages.filter((page) => page.problem);
  lines.push(
    problems.length
      ? `${problems.length} of ${pages.length} pages disagree. Fix urlType() or pageKind() from the page's markers, never by listing these urls; ` +
          'a shape that serves two kinds of page is settled by pageKind() at scrape time, which is not a problem to remove.'
      : typed
        ? `${pages.length} pages: urlType() and pageKind() agree on every one.`
        : `${pages.length} pages. This crawler does not type urls by their shape - it queues links by where it finds them - so only ` +
          'pageKind() is shown: a record page it calls unknown is one its scrape would not recognise.',
  );
  if (typed && pages.length >= 3 && pages.every((page) => page.queuedAs === null)) {
    lines.push(
      'urlType() dropped every url. It is given the full url: one that expects a pathname cannot be checked this way - ' +
        'give the crawler a classifier() that adapts it.',
    );
  }
  lines.push(
    'A dropped page that pageKind() calls unknown is dropped on purpose only if it carries no record: check a sample is not a ' +
      'record page pageKind() fails to recognise. A queued page of another kind (cms, home) is one the crawler vouches for.',
  );
  return lines.join('\n');
}
