# Discovery: queue every link, type it by url

Coverage comes from breadth, not from understanding one menu. This file holds
the rules behind steps 4, 6 and 7 of the skill: the url classifier, vouching
for pages that carry nothing, pagination and url normalisation.

## The classifier

On every page collect **all** the hrefs it offers and queue each one with a
type decided by a site-specific URL classifier, so nothing reachable is skipped
and nothing irrelevant is scraped. This example uses the shop domain's types;
use your domain's types in a new crawler:

```ts
/** What this site's url shapes mean; null queues nothing. Site-specific. */
private urlType(href: string): 'category' | 'product' | null {   // the domain's types
  const { pathname } = new URL(href, this.siteUrl.url);
  if (/^\/(collections|catalog)\//.test(pathname)) return 'category';
  if (/^\/products\/[^/]+$/.test(pathname)) return 'product';
  return null;
}

/** Queue everything this page links to. Call it from every scrape* method. */
private queueLinks(doc: XDocument) {
  for (const { href } of doc.links()) { // Absolute URLs: the core parses with baseUrl.
    const type = this.urlType(href);
    if (type) this.db.addUrl(href, type, this.siteUrl.id);
  }
}
```

`doc.links()` returns every `a[href]`, resolved against the page url. `addUrl`
dedupes by url hash and strips fragments, so repeats cost nothing, and rejects
a type the domain does not declare.

- **Queue from every page type.** Listings link pages no menu mentions, and
  detail pages link related pages and sibling sections. Type by url shape only:
  deriving the type from _where_ a link was found is how listings end up
  scraped as detail pages.
- **Write it from the table of step 2, and never from a list of slugs.** A
  hardcoded slug set is a snapshot of today's site: a section added tomorrow is
  mistyped or dropped, nothing throws, and the only symptom is a hole in the
  data. Rules come from url shape; a shape that serves two kinds of page is
  decided at scrape time (below).
- **Queue the domain's urls only.** Everything else returns `null` and is
  dropped, not recorded. Do not invent types for pages the schema has no
  record for.
- **Check the classifier against the site's own inventory.** After a short real
  crawl, `jscrawl_coverage <site>` diffs the sitemap against what was queued, by
  url shape, and lists pages whose saved records contradict their type. A shape
  the site lists and the crawler never queued is a classifier gap; fix the rule,
  do not add the slugs to a list. The `audit-crawl` skill covers reading that
  report.
- **Paginate to exhaustion; do not impose a maximum page or item count.**
  Follow `<link rel="next">`, page numbers or API cursors until the source's
  verified end signal (no next cursor, or an empty/short page when that API
  defines it as the end). A fixed `MAX_PAGES` silently loses large collections;
  raising it only postpones the bug. A full page means keep going. Detect
  repeated pages/cursors and throw with the collection URL and page/cursor
  instead of looping or claiming completion. Fetch failures and malformed
  responses are errors, not empty pages. Limit scope only when the user
  explicitly requests a partial crawl, and report that scope as incomplete.
- **Use sitemaps for discovery when available**, unless the site sets
  `allow`/`disallow` rules. Traverse their child sitemap files and queue detail
  URLs independently of listing pagination.
- **Normalise before queueing**: prefer the page's `<link rel="canonical">` when
  it has one, preserving pagination parameters/cursors needed to reach later
  pages rather than collapsing them to page 1. Drop tracking, sort and facet
  parameters (`?SID=`, `?cat=`, `?color=`, `?product_list_order=`,
  `…/category/<id>/`), or the same page is
  fetched repeatedly and each variant of a url becomes its own row. Skip search,
  account, cart, external hosts and document links.
- **Normalise asset urls too**: image `src`s often carry a resize service query
  (`?optimize=…&height=&width=&canvas=:`), sometimes with empty placeholders and
  sometimes with the thumbnail and the main image differing only in size. Strip
  the query so one file is one url - otherwise the same image is stored several
  times and the saved url is a sized derivative rather than the asset.
- **A type is a promise that the page carries that record.** Check it against the
  page marker before extracting, and correct it when the page knows
  better than the url did. `retypeUrl` fixes the queued url's type without
  re-fetching it, so this pass scrapes the page correctly and a later run
  dispatches it correctly; the correction is durable, because the next page that
  links to it guesses from the shape again and `addUrl` leaves a corrected type
  alone.
- **Vouch for a page that legitimately carries nothing - on positive evidence.**
  On a flat-slug site a CMS page (`/careers`, `/privacy-policy`) is
  indistinguishable from a detail page by url alone, so it gets queued as one.
  One switch at the top of every scrape method covers both rules:

  ```ts
  switch (this.pageKind(doc)) {
    case 'category':
      this.db.retypeUrl(this.siteUrl, 'category');
      return this.scrapeCategory(doc);
    case 'cms':
      this.siteUrl.data = 'cms page: no record';
      return this.queueLinks(doc);
    case 'product':
      break; // fall through and extract
    default:
      throw new Error(`Unrecognised template on ${this.siteUrl.url}`);
  }
  ```

  `pageKind` may return `cms` only for a marker that identifies a CMS page
  (`body.cms-page-view`, the theme's CMS layout class) - never as the else branch
  of "not the kinds I know". A vouch silences the validator, so if absence of
  evidence counts as evidence, an unrecognised template, a soft error served with
  HTTP 200 ("temporarily unavailable"), a login wall and a redesigned page
  are all filed as CMS pages: never scraped, never escalated, and the only
  symptom is data with holes in it. When nothing matches, throw - one
  investigation is cheaper than that. The note stays on the url row, where
  `jscrawl_inspectUrl` shows it.

And the home page (`seed`): queue every link. The classifier, not the menu, is
what makes the crawl complete - but a menu is also a list of entry points, so
put its destinations through the classifier as well, including the nodes the
theme marks as special: such a node's own url can be the only path to a whole
section, and dropping it loses the section. Finish by listing the menu's
top-level destinations and confirming each is queued or deliberately dropped,
and say which in your report.

## Bound work per listing page

The core buffers records until the scrape handler returns, then flushes them
in one transaction. Fetch and process one listing/API page per queued work item;
queue its continuation with a handler that understands that response. Keep the
page/cursor in the queued URL while linking every page to the same collection.
Do not accumulate all pages in an array or buffer a whole collection's records.
Streaming fetches alone do not bound memory if database records keep accumulating.
Do not call `db.flush()` inside a scraper: it breaks read-only previews and the
core's per-URL commit/error handling. Limit each work item's batch size, never
the total discovered.

## Check coverage

Check pagination with a full page followed by another
non-empty page and with the actual terminal response. Confirm that every
continuation is followed or queued, including on large collections. When
available, reconcile discovered URLs with the site's counts or sitemaps; a
successful scrape status alone does not establish complete discovery.
`jscrawl_classifierCheck` checks the classifier against sample pages before a
crawl; `jscrawl_coverage` checks everything a crawl queued after it.
