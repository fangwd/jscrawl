---
name: new-site
description: Build a crawler for a new website (e.g. "build a crawler for example.com"), from a first working version to a verified live scrape. Always starts by checking that the site has no crawler yet.
---

# Build a crawler for a new site

A site crawler is one file, `crawlers/<name>.ts`, where `<name>` is the site's
kebab-case name (`example-shop`). It exports `site` (seed urls and crawl
settings) and a default class extending the domain's crawler with one method
per page type: `scrapeSeed`, and `scrape<Type>` for each type the domain
declares. It may specialise a shared implementation under `crawlers/lib/`.
The domain's part of this skill, after the core's, names those types,
the template to start from, the API reference and what a page must yield.

Build it one step at a time, using each step's output in the next:

| Step                                      | Tool                                                             | Result                                                              |
| ----------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------- |
| 0. Check the site has no crawler          | grep, `jscrawl_sql`                                              | a new name, or the crawler to extend                                |
| 1. Survey the site, choose where to start | `jscrawl_siteSurvey`                                             | its size, platform and url shapes; a shared profile or the template |
| 2. Read one page of each type             | `jscrawl_pageRead`                                               | each page's type and the values it shows, and its saved html        |
| 3. Find those values in the source        | `jscrawl_locate`, `jscrawl_pageProbe`                            | the extraction source for each type                                 |
| 4. Write the listing method               | edit, `jscrawl_dryRun`                                           | records from a listing, and its pagination                          |
| 5. Write the detail method                | edit, `jscrawl_dryRun`                                           | complete records from two detail templates                          |
| 6. Add the menu and the sitemaps          | edit                                                             | discovery that does not depend on one path                          |
| 7. Check the classifier                   | `jscrawl_classifierCheck`                                        | `urlType()` and `pageKind()` agreeing with the site                 |
| 8. Set what the request promises          | edit                                                             | `site.expect`, scope, refresh                                       |
| 9. Register, check live, submit           | `jscrawl_populate`, `jscrawl_scrapeUrl`, `jscrawl_submitCrawler` | a pull request                                                      |

Most sites run on a platform another site here already runs on. Its shared
profile under `crawlers/lib/` is then the crawler, and the steps are the
same with less to write: each says what it means "on a profile".

Steps 1-5 give a first working version: write `crawlers/<name>.ts` in step 4,
as soon as step 3 has given you a source for the detail page and one way to
discover pages. Steps 6-8 make it complete. When a run is running out of
steps, write the file and report what is still unverified instead of
continuing to analyse: a crawler on disk can be improved by the next run, and
analysis cannot.

## Step 0 - check that the site has no crawler yet

**Before anything else, every time.** A site that already has a crawler must
not get a second one: two crawlers crawl it twice and split and double its
records. Before you survey, fetch or read anything, search for the request's
host without `www.` (`example.com`):

- the crawler modules and their test pages: grep for it, ignoring case, in
  `crawlers/*.ts` and `crawlers/fixtures/*/pages.json`;
- the registered sites, with `jscrawl_sql`:
  `select s.name, u.url from site s join url u on u.site_id = s.id where u.type = 'seed' and u.url ilike '%example.com%'`;
- `crawlers/<name>.ts` for the name you would give the site.

When anything matches, the site has a crawler. Do not write a new file or pick
a new name: say so first in your reply, then work on that crawler - read it,
run its fixtures with `jscrawl_validateCrawler`, and fix or extend it with the
steps below. Another storefront of the same shop (another country or
currency: `example.com/nz`, `nz.example.com`) is a separate site only when the
request asks for that storefront; when you cannot tell, stop and ask. Only when
nothing matches, go on. Registration enforces this: `jscrawl_populate` refuses a
crawler whose `SEED_URL` another site's seed covers (same host, `www.` aside, and
one path inside the other) and names the crawler to extend instead.

`crawlers/` and `data/` are gitignored here: `glob` and `grep` skip them unless
given `include_ignored: true`.

## Step 1 - survey the site, and choose where to start

`jscrawl_siteSurvey <home page url>`, once. It reads robots.txt, every sitemap
the site publishes and the home page, and returns:

- the platform the home page gives away (shopify, magento, wordpress, next.js);
- what robots.txt closes to every crawler. The crawl obeys it
  ([settings.md](settings.md)), so a site whose pages or listing APIs it
  disallows cannot be crawled - stop and report that rather than building
  around it;
- the urls the sitemaps list, by file and by **url shape**, with counts. The
  count of the shape that carries the records is the size estimate. Note the
  vertical, the platform and that estimate. When the request names a size and
  the site is far outside it, stop and report - or, if one section fits,
  propose the `allow`/`disallow` rules that keep the crawl to it and say what
  size they leave;
- the pages the home page and its menu link to, by shape, and the shapes no
  sitemap lists;
- three sample urls of each shape, from across the site.

A site without sitemaps still surveys its home page; take the estimate from a
listing API's total (`nbHits`, `total`) or the "N items" on its widest listing
in step 2. One survey is enough: do not fetch or count sitemaps by hand.

**Choose where to start, now.** A site is built on a shared profile when one
fits, and on the domain's template only when none does:

1. Look the platform up in the domain's table of profiles (its part of this
   skill) and read `crawlers/lib/README.md`, which says what each profile
   covers and which sites use it.
2. When a profile matches the platform, start from it: `crawlers/<name>.ts`
   configures the profile and adds only what this site's theme does
   differently. Read a site the README names for that profile to see the shape -
   it is this profile's example, not "another site's crawler".
3. A platform name does not prove the theme fits. Steps 2 and 3 are the proof:
   read a listing and two detail pages, and confirm the profile's source
   carries what they show. What it does not carry is what you write, in the
   profile's hooks.
4. Only when no profile matches, or its source does not carry the site's data,
   start from the template - and say in your report which profile you ruled
   out and why.

Do not copy a profile's code into the site's file, and do not write by hand
what a profile already does. Shared modules and their imports are
typechecked, rule-checked and submitted with the site; an edit to one changes
every site that uses it, so fix a profile only for what is wrong for all of
them, and recheck every affected site.

## Step 2 - read one page of each type

For each shape that could carry a record, read one sample:
`jscrawl_pageRead <url>` with `saveTo: "crawlers/fixtures/<name>/<file>"`. It
renders the page, returns its first fold as a screenshot with what the page
declares about itself (title, meta description, Open Graph tags, headings,
body class, JSON-LD types), and saves the rendered html.

Read the screenshot and state, before any tool call that follows:

1. **the page's type** - one of the domain's, or none of them (a content page,
   an error, a login wall) - with the visible evidence for it;
2. **the values the page shows**, exactly as displayed, for the fields the tool
   lists for that type. "Not shown" is an answer; a guess is not.

Read at least the home page, one listing page and two detail pages from
_different templates_: themes vary markup between pages of one kind on the
same site, and one page will not reveal that. Two pages from different
templates also tell you what is furniture: a block with the same content on
both is site-wide boilerplate, and only what differs is page data.

Fill this table as you go. It is the evidence `urlType()` and `pageKind()` are
written from in step 7, and it belongs in your report:

| Shape           | Carries                         | Marker on the page                                     |
| --------------- | ------------------------------- | ------------------------------------------------------ |
| `/tiles/<slug>` | a listing                       | `body.catalog-category-view`, listing cards            |
| `/<slug>`       | a detail page **and** a listing | `body.catalog-product-view` vs `catalog-category-view` |
| `/blog/<slug>`  | neither                         | -                                                      |

Two kinds of page often share one shape. Reading a page is cheap; guessing
from slug names is not.

List each page you keep in `crawlers/fixtures/<name>/pages.json` as you save
it, with its type and the url it came from, `file` relative to that directory:

```json
[
  { "type": "seed", "file": "home.html", "url": "https://..." },
  { "type": "<a domain type>", "file": "detail-1.html", "url": "https://..." }
]
```

`jscrawl_pageRead` saves the html the browser rendered. When step 3 finds the
values in the server's html, save that instead with `jscrawl_webfetch`
(`saveTo` the same file): it is what the crawl fetches. Pages can be many
megabytes: never `read` them whole or search them with ad-hoc scripts.

The screenshot is the first fold. For what is below it or behind a tab, a
gallery control or an option picker - or when a consent banner or a pop-up
covers the page - use the browser tools the domain's part of this skill
describes.

## Step 3 - find those values in the source

`jscrawl_locate` with the saved page and the values you read
(`{"name": "Walnut Desk", "price": "$1,234.50", "sku": "WD-120"}`). For each
value it lists every place that holds it, cheapest source first, and ends with
which source carries the most of them:

1. a saved JSON response (pass it in `json`);
2. embedded state in an inline script - named the way `jscrawl_html`'s `json`
   takes it (`window.X =`, `#script-id`, `[3]`);
3. JSON-LD;
4. an attribute;
5. the DOM, as a CSS selector with how many elements it matches.

Amounts match however they are formatted (`1234.5`, `"1,234.50"`, cents). Take
the cheapest source that carries the values, and confirm it on the second page
of that type: a location proven on one page is proven for that page.

A value it cannot find is not in the page's html: it arrives after load, is
built by script, or is part of an image. Then - and for any page whose values
sit only in the rendered DOM - run `jscrawl_pageProbe <url>`, which lists the
data calls the page makes, ranked by how many of the page's texts each carries.
Replay the best one with `jscrawl_webfetch`, save it, and pass it to
`jscrawl_locate` in `json`. [sources.md](sources.md) covers reading the probe,
the order to prefer sources in, where each framework keeps its data, and
proxies.

You now hold, for each page type, a source and the paths or selectors of its
values. That is enough to write the crawler: more research delays the first
extraction check.

## Step 4 - write the listing method

Start from the domain's template: copy it to `crawlers/<name>.ts` and set
`SEED_URL` to the home page url after redirects (omit it if the site has no
single entry page). Keep the template's pacing ([settings.md](settings.md)).

**On a profile**: write `crawlers/<name>.ts` as the profile configured for this
site - its seed url, site settings and the selectors or options the profile
takes - and run the listing fixture. The profile already lists, paginates and
queues; compare its records with what you read in step 2, and write a hook
only for what differs.

Write the listing method from the locations step 3 gave you, then run it:
`jscrawl_dryRun(site=<name>, pages=[{type,file,url}, ...])` returns the records
the crawler would save, by table; nothing is written. Compare them with what
you read off the page in step 2.

Pagination belongs to this step. Process one listing page per call and queue
its continuation; follow `<link rel="next">`, page numbers or an API cursor to
the source's verified end, with no maximum page or item count. A listing API's
paging parameters are found by fetching it with different parameters, not by
reading the site's code. [discovery.md](discovery.md) has the rules for
pagination, bounding work per page and normalising urls.

## Step 5 - write the detail method

**On a profile**: run both detail fixtures first. The profile saves what its
platform's source carries; the values you read in step 2 that are missing from
the records - a theme's specifications, units, documents, sections - are what
the profile's enrichment hook is for. Write that hook from step 3's locations.

Otherwise write the method from step 3's locations and run both detail
fixtures through `jscrawl_dryRun`. Then fill the gaps one at a time, re-running after each
change, until the records hold what you read off the page - and what the
domain's part of this skill requires of a detail page, which is more than the
first fold shows.

Rules for every scrape method:

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
- Derive TypeScript interfaces from the values of the saved response you
  consume (`jscrawl_json` on the file): similar endpoint names do not imply
  identical shapes. Plain strings are not `{name}` objects; verify units, nulls
  and optional fields on the chosen endpoint.
- Throw an error when a page does not look as expected; do not save partial data
  silently.
- Do not change `src/core`. If a helper is missing or wrong, say so in your
  report instead.

After a failing run, connect the error to the evidence you saved, edit the
extraction and rerun. Re-fetch only when the failure requires new live
evidence. If a selector or schema question survives two dry-runs, stop and
report the blocker with what you tried: a crawler that reports what it could
not extract is more useful than another permutation.

## Step 6 - add the menu and the sitemaps

A crawl that discovers pages one way has one way to miss them. The seed method
gives it three:

- **the menu**: the template's `scrapeNav` records what the site's navigation
  names and queues its destinations. Call it from the seed method only - the
  menu is the same on every page. Include the nodes the theme marks as special:
  such a node's own url can be the only path to a whole section. Finish by
  listing the menu's top-level destinations and confirming each is queued or
  deliberately dropped, and say which in your report;
- **the sitemaps** the survey found: the template's `queueSitemaps` reads them
  and queues every url through `urlType()`, independently of listing
  pagination. Leave it out when the site sets `allow`/`disallow` rules: detail
  urls rarely contain their section, so a focused crawl finds them through the
  allowed listings;
- **every link on every page**: each scrape method ends with `queueLinks`.

**On a profile**: discovery is the profile's. Check which of the three it does
(its README and the survey say), and configure or add the ones this site needs

- a sitemap path the profile takes as an option, a menu its selectors miss.

## Step 7 - check the classifier

`urlType()` decides what a url is queued as from its shape; `pageKind()`
decides what a fetched page is from its markers. Write both from the table of
step 2, never from a list of slugs ([discovery.md](discovery.md) has the rules,
and how a page that carries nothing is vouched for).

**On a profile** the classifier is the profile's, reached through its
`classifier()`; a site that classifies for itself declares its own `urlType()`
and `pageKind()`, or overrides `classifier()`. The check says which it asked. A
profile that queues links by where it finds them, not by url shape, is checked
on `pageKind()` alone.

Then `jscrawl_classifierCheck <name>`. It samples urls of each shape from the
sitemaps and the home page, asks `urlType()` what it would queue each as,
fetches the page as a crawl would (robots.txt obeyed, at the crawler's pace)
and asks `pageKind()` what it is, and lists every disagreement: a record page that would be dropped, a page queued as a type its
scrape would not recognise, a type the page contradicts. Fix the rule or the
marker and run it again; a shape that serves two kinds of page is settled by
`pageKind()` at scrape time and stays listed. Pass `urls` to check pages the
sample did not take.

After a real crawl, `jscrawl_coverage <site>` makes the same comparison on
everything the crawl queued; the `audit-crawl` skill covers reading it.

## Step 8 - set what the request promises

In `site`, record what a finished crawl must hold (`expect`), the part of the
site the request asked for (`scope`, with `allow`/`disallow`), how often to
re-crawl (`refresh`) and what to keep of each page (`pageSnapshots`).
[settings.md](settings.md) describes each. An expectation the site cannot meet
is a finding to report, not a reason to loosen it until it passes.

## Step 9 - register, check live, submit

Registration is part of creating the crawler, not an afterthought. Once the
crawler passes its check and its records cover the expected page information,
run `jscrawl_populate`; it upserts the crawler/site rows and queues `SEED_URL`.
A crawler whose site row is missing is not complete.

Then scrape a listing page and two detail pages live with `jscrawl_scrapeUrl`
(`site`, `url`, `type`). It saves what a crawl would and shows the saved
records and the urls the page queued. `jscrawl_sql` answers anything else.
Scrape them one at a time: each `jscrawl_scrapeUrl` paces only its own
requests, so parallel calls hit the site faster than its `waitTime` allows.

`url.status` is 2 when a page was scraped, -1 when the fetch failed, -2 when
the crawler threw and 3 when path rules or robots.txt exclude it; `url_fetch`
has the HTTP status and error of each fetch. A page whose scrape throws, or
whose records fail the domain's checks for its type, raises an issue during a crawl.

Do not start a crawl (`jscrawl_crawlStart`, `--crawl`) unless you are asked to.

Submitting is the last step of every build or fix: `jscrawl_submitCrawler`
commits `crawlers/<name>.ts` and its test pages to the `crawler/<name>` branch
and opens a pull request for review; prod crawls it once it is merged.

**Report**: the survey's estimate (vertical, platform, size, and any path
rules), the profile the crawler is built on or the one ruled out and why, the
table of url shapes, the source chosen for each page type and why,
the `site.expect` it set and why, the files you created, that
`jscrawl_populate` registered the site and its seed URL, the final check and
the test pages it ran on, the classifier check's result, what is extracted
from each page type, what the site has that is not extracted yet, anything
that failed, what the domain's part of this skill asks to report, and the pull
request.

## How edits are checked

Every edit of `crawlers/<name>.ts` is checked by itself: `jscrawl_checkCrawler`
typechecks it, checks it against this skill's rules (no page caps, no flush, no
slug lists, no /tmp files, no `this.client`, no scrape call left unawaited) and
dry-runs it on the test pages listed in `crawlers/fixtures/<name>/pages.json`,
including the domain's fixture contract, and appends the result to the edit's
output. A run that edited a crawler cannot finish until that check passes, so
list the test pages (step 2) before writing the crawler. Read the check after
each edit before the next one. A passing check is not the end: inspect the
records as well, since a successful scrape can still omit information.

What a test page's method fetches with `this.fetch` is recorded on its first
check in `<file>.fetches/` and replayed after, so checks are fast and
repeatable; saving the page again with `saveTo` drops its recordings. The
listed pages and what their methods fetched are versioned with the crawler
when it is submitted; anything else saved there is scratch and is not. List
the pages that pin down the crawler's behaviour, not every page you looked at.

`crawlers/` is a separate git repository that the deployment ignores, so its
history stays out of the deployment's. Keep imports relative as
`../src/core/...` - the directory must stay inside the deployment's checkout,
because Node resolves a module's imports from its real path. Its dependencies
come from the deployment's `package.json`; there is none here.

The live database is configured by `etc/config.json` (or `JSCRAWL_CONFIG`),
with `DATABASE_URL` from the environment or `.env` taking precedence. Use the
deployment's configured database; do not start a replacement database when
investigating connection failures.

## Not part of building a crawler

Each of these has cost whole runs:

- enumerating or counting a site's sitemaps, collections or sections by hand:
  `jscrawl_siteSurvey` does it in one call, and `jscrawl_coverage` checks a
  crawl against it;
- searching a saved page for one value after another: `jscrawl_locate` takes
  them all;
- downloading or grepping the site's JavaScript bundles to reverse-engineer an
  API: if `jscrawl_pageProbe` does not list a call carrying the data, use a
  source it does list, embedded state, or the DOM;
- reading `src/core`, `node_modules`, dependency sources or another site's crawler
  (the crawler Step 0 found for this site is not another site's: it is where you start):
  the API you need, input types included, is in the domain's API reference;
  the profiles under `crawlers/lib/` are the reuse entry points, and one site
  its README names for the profile you chose is that profile's example;
- repairing data by hand: data a scrape left wrong is fixed by fixing the
  crawler and scraping the page again; when a re-scrape cannot replace what an
  earlier one saved (rows stacking up), that is a core issue to report;
- working around a core limit in the crawler - a `db.flush()` mid-scrape, a cap
  on how many urls one page queues, a retry loop around a core call: when the
  core fails on something a crawler legitimately does, stop and report it as a
  core issue, with the error and the call that caused it;
- disposable tooling: throwaway scripts to fetch, parse or dry-run. The tools
  below cover each;
- starting a crawl (`jscrawl_crawlStart`, `--crawl`): building and checking a
  crawler takes a few pages; a crawl is the user's decision.

If a repeated-call warning appears, use the results already collected to make
the next edit or check; if no concrete next step is available, report the
blocker and the unfinished work.

## Tools

- `jscrawl_siteSurvey` - the platform, robots.txt, the sitemaps and the home
  page's links by url shape, with counts and sample urls (step 1).
- `jscrawl_pageRead` - a page's first fold as a screenshot, what it declares
  about itself, and its rendered html saved (step 2).
- `jscrawl_locate` - where values read off a page live in its saved source and
  in saved JSON responses (step 3).
- `jscrawl_pageProbe` - a live page's network data (method, request body and
  headers, page-text score and paths), embedded state and framework;
  `interact: true` adds what picking options fetches, `saveTo` saves the
  rendered html.
- `jscrawl_webfetch` - fetches a url as the crawler does; `format: "json"`
  summarizes a JSON endpoint (keys, array lengths, first item) instead of
  dumping it, `format: "jsonld"` shows the page's structured data; `saveTo`
  creates missing dirs; `method`, `body` and `headers` replay a data call the
  probe listed; a gzipped body (`.xml.gz`) is unzipped.
- `jscrawl_html` - a saved page by CSS selector; `search` lists each place it
  contains a text, with the markup around it; `output: "scripts"` inventories
  inline scripts (id, type, size, whether the content or an assigned value
  parses as JSON, top-level keys); `json: "#script-id"`, `json: "[3]"` (an
  inventory index) or `json: "window.X ="`, plus an optional dotted `path`
  ("products.0.title"), extracts an embedded JSON blob.
- `jscrawl_json` - a saved JSON response offline: omit `path` for a summary, or
  use a dotted field/index path for the exact value. Missing paths are errors.
- `jscrawl_dryRun` with `pages: [{type,file,url}, ...]` runs every fixture in one
  call, reports failures per page, and accepts `tables` to narrow the output;
  `jscrawl_scrapePreview` is its one-page form. Both write nothing.
- `jscrawl_checkCrawler` runs by itself after each crawler edit ("How edits are
  checked"); `jscrawl_validateCrawler` is the same for any list of pages, with
  the records.
- `jscrawl_classifierCheck` - `urlType()` and `pageKind()` against sample pages
  of each url shape (step 7).
- `jscrawl_populate` registers every crawler under `crawlers/` with the
  database: crawler/site rows and `SEED_URL`. Idempotent.
- `jscrawl_scrapeUrl` fetches, scrapes and saves one live page with the
  registered crawler and shows what was saved (step 9).
- `jscrawl_{{inspectTool}}` shows what a url produced, from the saved records.
- `jscrawl_dbSchema` lists tables, columns and constraints - consult it before
  `jscrawl_sql`.
- `jscrawl_exportFeed` exports the site's saved records as the domain's feed,
  when it has one, and reports what it holds and its gaps.
