---
name: new-site
description: Build a crawler for a new website (e.g. "build a crawler for example.com"), from a first working version to a verified live scrape.
---

# Build a crawler for a new site

A site crawler is one file, `crawlers/<name>.ts`, where `<name>` is the site's
kebab-case name (`example-shop`). It exports `site` (seed urls and crawl
settings) and a default class extending the domain's crawler with one method
per page type: `scrapeSeed`, and `scrape<Type>` for each type the domain
declares. It may specialise a shared implementation under `crawlers/lib/`.
The domain's part of this skill, after the core's, names those types,
the template to start from, the API reference and what a page must yield.

Scout first, then build in two passes, and write the file at the end of the first.

**Scout - is this the site you want?** Before any fixture, estimate how much
the crawl will save from one number the site already states: the item count of
its main sitemap (one file, not the whole index), a listing API's total
(`nbHits`, `total`, `TotalRecordCount`), or the "N items" on its widest
listing. Note the vertical, the platform and that estimate. Read the site's
`robots.txt` while you are there: the crawl obeys it (see "Site settings"), so
a site whose pages or listing APIs it disallows cannot be crawled - stop and
report that rather than building around it. When the request names a size and
the site is far outside it, stop and report - or, if one section fits, propose
the `allow`/`disallow` rules that keep the crawl to it and say what size they
leave. One estimate is enough; counting every sitemap or collection is not
scouting.

During scouting, inspect the domain's documented profiles in `crawlers/lib/`.
When the platform and template match a known profile, specialise it with the
site's configuration and enrichment hooks. Verify the match on a listing and
two distinct product pages; a platform name alone does not prove theme compatibility.
Shared modules and their imports are typechecked, rule-checked and submitted
with the site, and edits to them require rechecking every affected site.

**Pass 1 - a first version.** Start with `jscrawl_pageProbe` on the url you
were given ("Probe the live page"), then on one detail page. **Write
`crawlers/<name>.ts` as soon as you hold both:**

1. a **content source** for the detail page you confirmed and saved with
   `jscrawl_webfetch` - a JSON endpoint, embedded state, JSON-LD or the page's
   DOM - and
2. **one discovery source** - a sitemap, a listing JSON endpoint, or the links
   on a listing page.

That is the stop condition, not a budget: once both are in hand, more research
delays the first useful extraction check. Write the file and run an exploratory
`jscrawl_dryRun` on the fixtures ("Run it right away"). A first working version
is a checkpoint; the completion gate may still fail until pass 2 fills the
domain's fixture contract.

**Pass 2 - completeness.** After that first extraction, fill the domain's
fixture contract, then cover listing pagination to exhaustion, url
classification and the coverage checks ("Discovery"). Run final
`jscrawl_validateCrawler`, then `jscrawl_populate`. A listing API's paging
parameters are found by fetching it with different parameters, not by reading
the site's code.

**Not part of building a crawler** - each of these has cost whole runs:

- enumerating or counting a site's sitemaps, collections or sections: the url
  classifier plus a real crawl does that, and `jscrawl_coverage` checks it;
- downloading or grepping the site's JavaScript bundles to reverse-engineer an
  API: if `jscrawl_pageProbe` does not list a call carrying the data, use a
  source it does list, embedded state, or the DOM;
- reading `src/core`, `node_modules`, dependency sources or another site's crawler:
  the API you need, input types included, is in the domain's API reference;
  the documented profiles under `crawlers/lib/` are the reuse entry points;
- repairing data by hand: data a scrape left wrong is fixed by fixing the
  crawler and scraping the page again; when a re-scrape cannot replace what an
  earlier one saved (rows stacking up), that is a core issue to report;
- working around a core limit in the crawler - a `db.flush()` mid-scrape, a cap
  on how many urls one page queues, a retry loop around a core call: when the
  core fails on something a crawler legitimately does, stop and report it as a
  core issue, with the error and the call that caused it;
- starting a crawl (`jscrawl_crawlStart`, `--crawl`): building and checking a
  crawler takes a few pages ("Register it"); a crawl is the user's decision.

Every edit of `crawlers/<name>.ts` is checked by itself: `jscrawl_checkCrawler`
typechecks it, checks it against this skill's rules and dry-runs it on the test
pages listed in `crawlers/fixtures/<name>/pages.json`, and appends the result to the
edit's output. A run that edited a crawler cannot finish until that check
passes, so list the test pages ("Save a few pages") before writing the crawler.
What a test page's handler fetches with `this.fetch` is recorded on its first
check in `<file>.fetches/` and replayed after, so checks are fast and
repeatable; saving the page again with `saveTo` drops its recordings.

`crawlers/` and `data/` are gitignored here: `glob` and `grep` skip them unless
given `include_ignored: true`.

When a run is running out of steps, write the file and report what is still
unverified instead of continuing to analyse: a crawler on disk can be improved by
the next run, and analysis cannot.

## Reuse evidence and repair the reported failure

Save a confirmed JSON endpoint with `jscrawl_webfetch` (`format: "json"`,
`saveTo: "crawlers/fixtures/<site>/detail.json"`). Use `jscrawl_json` on that file
to inspect the exact fields you will consume, such as `options.0` and
`images.0`. Derive TypeScript interfaces from those values: similar endpoint
names do not imply identical shapes. Plain strings are not `{name}` objects;
verify units, nulls and optional fields on the chosen endpoint.

After a failing preview, connect the error to that saved evidence, edit the
extraction and rerun validation. Re-fetch only when the failure requires new
live evidence. Changing an echo label or rereading an unchanged interface does
not test a fix. If a repeated-call warning appears, use the results already
collected to make the next edit or check; if no concrete next step is available,
report the blocker and the unfinished work.

## Save a few pages

With `jscrawl_webfetch` and `saveTo`, save into `crawlers/fixtures/<name>/`:
the home page as `home.html`, one listing page, and at least two pages of each
detail type from *different templates* - themes vary markup between pages of
one kind on the same site (classed vs class-less tables, different accordion
wrappers), and one fixture will not reveal that. Two fixtures from different
templates also tell you what is furniture: a text block with the same content
in both is site-wide boilerplate, and only what differs is page data. Check
that before deciding what to store per record.

Pages can be many megabytes: never `read` them whole or search them with ad-hoc
scripts; use the `jscrawl_html` tool - CSS selectors, or `search` to find where a
text or class name occurs.

`jscrawl_webfetch` with `format: "jsonld"` shows the page's structured data.

Then list the pages the crawler is checked on, as you save them, in
`crawlers/fixtures/<name>/pages.json` - every test page, with its type and the
url it came from, `file` relative to that directory:

```json
[{"type": "seed", "file": "home.html", "url": "https://..."},
 {"type": "<a domain type>", "file": "detail-1.html", "url": "https://..."}]
```

The listed pages and what their handlers fetched are versioned with the crawler
when it is submitted ("Report"); anything else saved there is scratch and is
not. List the pages that pin down the crawler's behaviour, not every page you
looked at. The domain may require more of an entry (its fixture contract)
before final validation can pass.

## Probe the live page and pick the extraction source

Saved HTML shows what the *server* sent; the data you need may arrive later or
live outside the DOM. Before writing selectors, run `jscrawl_pageProbe <url>` on
a live listing and a detail page. Like a devtools session, it reports: the data the
page fetched over the network (JSON, and the html or text fragments its scripts
load, with method, request body and the page's own request headers), inline
scripts that carry embedded state (`window.__X = {...}`, pure-JSON scripts, and
whether the value parses as JSON), framework hints, JSON-LD types, and raw vs
rendered page size. On a page with option pickers, probe with
`interact: true`: it picks another value in each picker and lists what that
fetched - where the combinations the page does not render come from.

Each source is scored by how many of the rendered page's visible text lines it
contains (`59/76 page texts`), network calls are ranked by that score, and a
matching JSON response lists the paths holding those texts (`page texts at:
restaurant.menu.categories.*.items.*.name (23)`). A call with most of the page's
texts at the paths of the records you want **is** the data source - do not look
further:

1. replay it with `jscrawl_webfetch` using the listed `method`, `body` and
   `headers` (`format: "json"`, `saveTo: "crawlers/fixtures/<name>/feed.json"`);
2. read the fields under the listed paths with `jscrawl_json`;
3. write the crawler on that feed.

When one feed carries the whole site (a single-page menu or storefront),
the url-shape research below reduces to the page you were given, and the only
HTML fixture needed is that page.

Then choose the cheapest source that carries the data, in this order:

1. **A static JSON/API endpoint** from the network list. Confirm with
   `jscrawl_webfetch <that url>` (plus its `method`/`body` for a POST) that it
   answers without a browser (no cookies/JS needed). If it does, fetch and
   parse it in the crawler - stable, small, fast.
2. **Embedded state** in an inline script that `jscrawl_pageProbe` marks as parsing:
   `embeddedJson(doc, 'window.X =')` in the crawler. Typical for next.js
   (`__NEXT_DATA__`), nuxt (`__NUXT_DATA__`), SSR hydration blobs, theme
   picker JSON.
3. **JSON-LD**: `jsonLd(doc)`.
4. **Server-rendered DOM** selectors, found with the `jscrawl_html` tool on the saved
   page.
5. **Rendered DOM only** when the raw HTML is an empty JS shell (rendered size
   far above raw, no state script, no data endpoints): set
   `usePuppeteer: true` in the site config so the crawler fetches rendered
   pages, and scrape those. Save their fixtures with `jscrawl_pageProbe`'s
   `saveTo`, which writes the rendered html: `jscrawl_webfetch` saves what the
   server sent.

Framework cheat sheet (where page data usually hides):

| Framework | First places to look |
|---|---|
| next.js | `__NEXT_DATA__` JSON script; `/api/` route XHRs; RSC payloads in the network list |
| nuxt / vue | `__NUXT_DATA__` / `window.__NUXT__`; pinia hydration script; `/api/_/` XHRs |
| angular | server-rendered markup, or XHRs to `/api/`; `ng-version` attribute |
| react SPA | XHR / GraphQL endpoints in the network list; else rendered DOM |
| wordpress | server-rendered markup + JSON-LD; `wp-json/` REST (often authed); generator meta |
| plain php / server-rendered | DOM selectors + JSON-LD; probes usually show no XHR data |

Keep the response from the static confirmation above as evidence. If the endpoint
only works inside the browser, prefer embedded state or the rendered DOM instead.

When the request says the site shows different prices or products by country,
set `proxy: { type, country }` in the site config before fetching - `type` one
the deployment's proxy provider offers (its instructions name them), `country`
the request's: the crawl then goes out through a proxy in that country. Pass
`site` to `jscrawl_webfetch` and `jscrawl_pageProbe` until the crawler is
registered, so what you study is what the crawl will see; after that, the
site's urls go through its proxy on their own.

## Learn what the site's urls mean, from pages

In pass 1 the classifier only needs the shapes of the pages you saved - the
detail and listing urls you already fetched. Widen it in pass 2.

Before finalising the url classifier, find out what each url *shape* serves. From the
sitemap (`robots.txt` advertises it), the menu and one listing page, pick out the
distinct shapes - `/`, `/<slug>`, `/tiles/<slug>`, `/blog/<slug>`,
`/catalog/product/view/id/<n>/…` - and fetch two or three urls of each with
`jscrawl_webfetch` (`jscrawl_pageProbe` when a page is a client-side shell). For
each shape note the record it carries and the marker on the page that says so,
for example on a shop:

| Shape | Carries | Marker on the page |
|---|---|---|
| `/tiles/<slug>` | category | `body.catalog-category-view`, listing cards |
| `/<slug>` | product **and** category | `body.catalog-product-view` vs `catalog-category-view` |
| `/blog/<slug>` | neither | - |

This table is the evidence `urlType()` is written from, and it belongs in your
report. Fetching is cheap; guessing from slug names is not. Two kinds of page
often share one shape, and a hand-written list of slugs is a snapshot of
today's site that silently rots the day it adds a section.

## Site settings

Start from the domain's template. Set `SEED_URL` to the home page url (after
redirects), or omit it if the site has no single entry page.

Keep the template's pacing (`waitTime`, `randomWait`) and leave `threadCount`
at its default of one; the core also waits at least the `Crawl-delay` the
site's robots.txt asks for. Raise none of these unless the user asks.

The core obeys each host's robots.txt for every request a crawl makes, pages
and `this.fetch` calls alike: a page it disallows is recorded as disallowed
and never fetched, a handler fetch it disallows fails the scrape, and while a
host's robots.txt cannot be served (5xx, no answer) nothing is fetched from it.
Path rules can narrow a crawl further but cannot open what robots.txt closes.

`site.allow` and `site.disallow` keep a crawl to part of a site: url paths in
robots.txt syntax (`*`, a trailing `$`), the longest matching rule winning, as
in `disallow: ['/'], allow: ['/collections/cameras']`. They hold for every
page type but the seed and images: excluded urls are recorded with status 3
(disallowed) and never fetched. Detail urls rarely contain their section
(`/products/<handle>`), so a focused crawl finds them through the allowed
listings: with rules set, do not queue the main sitemap. Run
`jscrawl_populate` after changing them.

**A partial site** ("all their pizzas", "everything except the blog") is
decided once, here, and written into the crawler as rules; the crawl itself
never asks anyone. State the request in `site.scope`, in words
(`scope: 'pizzas only'`): coverage and triage read it, so what the crawl leaves
out on purpose is not chased as missing. Omit it for a whole site. Then pick
the cheapest rule that expresses it, in this order:

1. **Path rules**, when the site's sections are url paths: classify the
   branches of its menu or listing API once and write the in-scope ones as
   `allow` (or the excluded ones as `disallow`).
2. **Listing fields**, when sections are not paths: a listing that carries each
   item's type, tags or section decides before the detail url is queued. Keep
   the matching values as constants in the crawler, from the values the site
   actually uses.
3. **The detail page**, when only it says: scrape it, and for an out-of-scope
   page save nothing and vouch with `url.data = 'out of scope: <why>'`. It
   costs a fetch per excluded page, so use it only when 1 and 2 cannot.

Report the rule and what it keeps, so the user can correct the classification.

**What the request promises: `site.expect`.** Record what a finished crawl
must hold, in the domain's terms (its part of this skill says which), so the
build and every complete crawl are checked against the request, not against
whatever the crawler happens to save. After each complete crawl the server
checks the site against it and raises an acceptance issue for a shortfall;
`jscrawl_checkExpectations` shows the numbers. An expectation the site cannot
meet is a finding to report, not a reason to loosen it until it passes.

**Keeping the data fresh.** When the request asks for current data, set
`site.refresh` to that interval (`'1d'`, `'7d'`, `'6h'`). Once someone has
crawled the site, the server re-crawls all of it that long after each crawl
started. Omit it otherwise: it is re-crawled only by hand. Keep the interval
longer than a full crawl takes at the site's pace.

Set `site.pageSnapshots` to `'gzip'` (default), `'raw'`, or `'off'`. These are
HTML/JSON response bodies saved for debugging and replay; requests always fetch
fresh content. Prefer gzip for large pages with repeated CSS. Before a full
crawl, estimate storage from several representative pages and the site's size;
`jscrawl_webfetch` with `saveTo` reports gzip bytes per page. Use off when bodies
should not be retained; fetch metadata, extracted records and validation still work, but historical page
comparisons need an existing snapshot. Keep a few explicit fixtures for testing.
Run `jscrawl_populate` after changing this setting, then restart an active crawl.
The tool reports the registered policy; `jscrawl_inspectUrl` reports it too.

`crawlers/` is a separate git repository that the deployment ignores, so its
history stays out of the deployment's. Keep imports relative as
`../src/core/...` - the directory must stay inside the deployment's checkout,
because Node resolves a module's imports from its real path. Its dependencies
come from the deployment's `package.json`; there is none here.

### Work efficiently

A crawler is written once and then iterated. Spend turns on the crawler, not on
disposable tooling:

- Read the check after each edit before the next one; for the records
  themselves, `jscrawl_dryRun` with `tables` shows them. Both write nothing.
- If a selector or schema question survives two dry-runs, stop and report the
  blocker with what you tried. A crawler that reports what it could not extract
  is more useful than another permutation.

The live database is `DATABASE_URL` from `.env`, which every jscrawl tool uses.
The port in `etc/config.json` is only the docker fallback: never start Docker or
Postgres to look for it.

## Run it right away

`jscrawl_scrapePreview(site=<name>, type=<the page's type>,
file="crawlers/fixtures/<name>/<file>", url=<the page's url>)` returns the
records the crawler would save, by table; nothing is written. For several pages,
`jscrawl_dryRun(site=<name>, pages=[{type,file,url}, ...])` does the same in one
call. Then fill the gaps one at a time, re-running after each change, as the
domain's part of this skill describes.

General rules for every handler:

- Target structure, not theme classes: table rows with th+td, dt/dd pairs,
  label/value lists, aria roles. Class names vary per template; table shapes
  rarely do. When a section wraps its tables, iterate the sections and keep
  their titles.
- A `#id` selector means one element on the whole page. Inside a repeated card
  use a class or a `data-*` attribute: a theme that repeats an id per card works
  only while it keeps breaking the rules, and fails silently when it stops.
- A fallback is a decision, not a default. When the source you preferred is
  missing and you read a weaker one instead, log it and say so in the report -
  a silent fallback is how a site redesign turns into quietly thinner data.
- A fallback must build the **same record** as the primary path: fill what the
  primary fills, or report which fields you could not. A fallback that saves a
  thinner record is worse than throwing: the row looks complete, so nothing
  ever asks about the missing fields.
- When you save an HTML block, save the container's `outerHTML`, or its
  `innerText` if you want text: one line per paragraph, list item or `<br>`,
  without `<style>` and `<script>` contents. `text()` and `textContent` include
  those, so taking the text of a wrapper - a modal or an accordion, which often
  carries its own CSS - that way yields a record that begins with stylesheet
  rules. An HTML string (a description in JSON) reads the same through
  `htmlText(html)`.
- Throw an error when a page does not look as expected; do not save partial data
  silently.
- Do not change `src/core`. If a helper is missing or wrong, say so in your
  report instead.

### Bound work per listing page (pass 2)

The core buffers records until the scrape handler returns, then flushes them
in one transaction. Fetch and process one listing/API page per queued work item;
queue its continuation with a handler that understands that response. Keep the
page/cursor in the queued URL while linking every page to the same collection.
Do not accumulate all pages in an array or buffer a whole collection's records.
Streaming fetches alone do not bound memory if database records keep accumulating.
Do not call `db.flush()` inside a scraper: it breaks read-only previews and the
core's per-URL commit/error handling. Limit each work item's batch size, never
the total discovered.

## Discovery (pass 2): queue every link, type it by url

Coverage comes from breadth, not from understanding one menu. On every page
collect **all** the hrefs it offers and queue each one with a type decided by a
site-specific url classifier, so nothing reachable is skipped and nothing
irrelevant is scraped:

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
  for (const { href } of doc.links()) {   // absolute: the core parses with baseUrl
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
  deriving the type from *where* a link was found is how listings end up
  scraped as detail pages.
- **Write it from the evidence above, and never from a list of slugs.** A
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
  pages rather than collapsing them to page 1. Drop tracking, sort and facet parameters (`?SID=`, `?cat=`,
  `?color=`, `?product_list_order=`, `…/category/<id>/`), or the same page is
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
    case 'category': this.db.retypeUrl(this.siteUrl, 'category'); return this.scrapeCategory(doc);
    case 'cms':      this.siteUrl.data = 'cms page: no record'; return this.queueLinks(doc);
    case 'product':  break;                    // fall through and extract
    default:         throw new Error(`Unrecognised template on ${this.siteUrl.url}`);
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

A passing check is not the end: inspect the records as well
(`jscrawl_dryRun`), since a successful scrape can still omit information.

**Coverage self-check.** Check pagination with a full page followed by another
non-empty page and with the actual terminal response. Confirm that every
continuation is followed or queued, including on large collections. When
available, reconcile discovered URLs with the site's counts or sitemaps; a
successful scrape status alone does not establish complete discovery.

## Tools

- `jscrawl_checkCrawler` runs by itself after each crawler edit: typecheck, the
  rule check (no page caps, no flush, no slug lists, no /tmp files, no
  `this.client`, no scrape call left unawaited) and a dry run of the pages in
  `pages.json`, including the domain's fixture contract.
  `jscrawl_validateCrawler` is the same for any list of pages, with the records.
- `jscrawl_dryRun` with `pages: [{type,file,url}, ...]` runs every fixture in one
  call, reports failures per page, and accepts `tables` to narrow the output;
  `jscrawl_scrapePreview` is its one-page form. Both write nothing.
- `jscrawl_html` with `search` lists each place a saved page contains a text,
  with the markup around it: where a value lives, which classes a section uses.
- `jscrawl_html` with `output: "scripts"` inventories inline scripts (id, type, size,
  whether the content or an assigned value parses as JSON, top-level keys);
  with `json: "#script-id"`, `json: "[3]"` (an inventory index - the way to reach an
  anonymous `type="application/json"` script) or `json: "window.X ="`, plus an
  optional dotted `path` ("products.0.title"), it extracts an embedded JSON blob.
- `jscrawl_webfetch` with `format: "json"` summarizes a JSON endpoint (keys, array
  lengths, first item) instead of dumping it; `saveTo` creates missing dirs;
  `method`, `body` and `headers` replay a data call the probe listed; a
  gzipped body (`.xml.gz`) is unzipped.
- `jscrawl_json` inspects that saved response offline: omit `path` for a summary,
  or use a dotted field/index path for the exact value. Missing paths are errors.
- `jscrawl_pageProbe` shows a live page's network data (method, request body and
  headers, page-text score and paths), embedded state and framework;
  `interact: true` adds what picking options fetches, `saveTo` saves the
  rendered html.
- `jscrawl_populate` registers every crawler under `crawlers/` with the
  database: crawler/site rows and `SEED_URL`. Idempotent.
- `jscrawl_scrapeUrl` fetches, scrapes and saves one live page with the
  registered crawler and shows what was saved ("Register it").
- `jscrawl_{{inspectTool}}` shows what a url produced, from the saved records.
- `jscrawl_dbSchema` lists tables, columns and constraints - consult it before
  `jscrawl_sql`.
- `jscrawl_exportFeed` exports the site's saved records as the domain's feed,
  when it has one, and reports what it holds and its gaps.

## Register it, then check it live on a few pages only

Registration is part of creating the crawler, not an afterthought. Once the
crawler passes its check and its records cover the expected page information,
run `jscrawl_populate`; it upserts the
crawler/site rows and queues `SEED_URL`. A crawler whose site row is missing is
not complete.

Then scrape a listing page and two detail pages live with `jscrawl_scrapeUrl`
(`site`, `url`, `type`). It saves what a crawl would and shows the saved
records and the urls the page queued. `jscrawl_sql` answers anything else.
Scrape them one at a time: each `jscrawl_scrapeUrl` paces only its own
requests, so parallel calls hit the site faster than its `waitTime` allows.

`url.status` is 2 when a page was scraped, -1 when the fetch failed, -2 when
the crawler threw and 3 when the site's path rules exclude it; `url_fetch` has
the http status and error of each fetch.

Do not start a crawl (`jscrawl_crawlStart`, `--crawl`) unless you are asked to.

## Report

Reply with: the scout's estimate (vertical, platform, size, and any path
rules), the `site.expect` it set and why, the files you created, that
`jscrawl_populate` registered the site and its seed URL, the final check and
the test pages it ran on, what is extracted from each page type, what the site
has that is not extracted yet, anything that failed, what the domain's part of
this skill asks to report, and the pull request `jscrawl_submitCrawler`
opened. Submitting is the last step of every build or fix: it commits
`crawlers/<name>.ts` and its test pages to the `crawler/<name>` branch and
opens a pull request for review; prod crawls it once it is merged.
