// The new-site skill's rules a crawler's source can be checked against without
// running it: each pattern is one way generated crawlers have lost data before.

export interface LintFinding {
  line: number;
  rule: string;
  message: string;
}

const RULES: { rule: string; pattern: RegExp; message: string }[] = [
  {
    rule: 'page-cap',
    pattern: /\bMAX_[A-Z_]*(PAGE|PRODUCT|ITEM|RESULT|URL|COUNT)S?\b\s*=/,
    message:
      "a fixed cap on pages or products silently loses large collections: paginate to the source's end signal " +
      'and throw on a repeated page instead',
  },
  {
    rule: 'flush',
    pattern: /\.flush\(\)/,
    message:
      'the core flushes after each page; a flush in a scraper breaks previews and per-url error handling',
  },
  {
    rule: 'slug-list',
    pattern: /\b[A-Z_]*(CATEGORY|CMS|COLLECTION|PAGE)_(SLUGS|HANDLES|PATHS)\b\s*=/,
    message:
      'a list of slugs rots the day the site adds a page: classify by url shape and page markers',
  },
  {
    rule: 'raw-client',
    pattern: /this\.client\.get\(/,
    message:
      "this.client skips the site's pacing and is not recorded for re-scrapes: use this.fetch(url, { method, headers, body })",
  },
  {
    rule: 'unawaited-scrape',
    pattern: /(?<!\b(?:await|return)\s+)\bthis\.scrape\w*\(/,
    message:
      'a scrape handler call that is not awaited saves its records after the page is flushed, and its errors are ' +
      'lost: `await this.scrapeProduct(doc)` (or return it)',
  },
  {
    rule: 'tmp-path',
    pattern: /['"`]\/tmp\//,
    message:
      'crawlers keep no files of their own: test pages live in crawlers/fixtures/<site>/ and pages in the snapshot store',
  },
];

/** Findings for a crawler's source; empty when it keeps to the rules. */
export function lintCrawler(source: string): LintFinding[] {
  const findings: LintFinding[] = [];
  source.split('\n').forEach((text, index) => {
    if (/^\s*(\/\/|\*)/.test(text)) return;
    for (const { rule, pattern, message } of RULES) {
      if (pattern.test(text)) findings.push({ line: index + 1, rule, message });
    }
  });
  return findings;
}
