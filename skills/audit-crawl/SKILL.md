---
name: audit-crawl
description: Audit crawl coverage and URL classification by comparing a site's sitemaps and saved records with queued URLs. Use for questions about missing pages, completeness, or incorrect page types.
---

# Audit a crawl

Site-level and read-only: did the crawl reach what the site publishes, and did
the url classifier type each page correctly? For one url's data use
`verify-url` instead. Report what to change in `crawlers/<site>.ts`; change it
only when the task asks for a fix.

## 1. One call for the shape of the problem

`jscrawl_coverage <site>` compares the urls the site's sitemaps list with the
urls the crawler queued (and their type), and with what each scraped page saved.
Read its output in this order:

- **`scope:`** - the crawl keeps to part of the site on purpose. Urls outside
  it are correctly never queued, disallowed or vouched; judge completeness
  against the scope, and report only what inside it is missing.
- **`the crawl is partial`** - say so up front, or stop. With urls still queued,
  `never queued` means "not reached yet" as often as "rejected".
- **`sitemaps: none found`** - the site publishes no inventory, so coverage
  cannot be measured against it; only the suspects and the unlisted shapes say
  anything. Report that instead of guessing.
- **`N never queued`, by shape** - url shapes the site lists and the crawler has
  not queued. Each is either a classifier gap or a correct drop; step 2 decides.
- **`type suspects`** - pages whose saved records contradict their type. Step 3
  decides whether each kind is a bug.
- **`queued, listed by no sitemap`** - usually fine (pages a sitemap omits, like
  a page reached only from a listing). In bulk it means the crawler invents
  urls, typically by not canonicalising them.

## 2. Judge a missing shape on the page, not on its name

For every shape with a meaningful count, take one sample url and look at it:
`jscrawl_webfetch_readonly`, or `jscrawl_pageProbe` when the page is a
client-side shell. Decide what record it carries.

- **A page of one of the domain's types that the site lists and we never
  queued** is a classifier gap. Name the shape, its count, and the rule in
  `urlType()` (or the normalisation before it) that drops the url - a rejected
  first path segment, a pattern that only matches one spelling, a
  canonicalisation that never fires.
- **A page carrying no record** the domain keeps is correctly dropped. Say so
  and move on.
- **One shape serving two types** is the interesting finding: on a flat-slug
  site two kinds of page are indistinguishable by url. The fix is not a bigger
  slug list - it is deciding at scrape time from a marker on the page and
  correcting the row with `db.retypeUrl`, which the `new-site` skill describes.

When large listings are missing pages, check the crawler for fixed page or
item caps and early pagination exits. Compare the last fetched page and its
continuation with the site's counts or sitemaps. A full final page at a
hardcoded cap is truncation, even when every fetched URL is marked done.
Recommend following pagination to exhaustion, rather than increasing the cap.

For memory spikes or long transactions, check whether one listing handler fetches
all pages or buffers a whole collection before returning. Recommend separate
queued pagination items, with full details saved on the detail pages.

## 2b. Two things the sitemap diff cannot see

- **A menu destination nothing else links to.** Fetch the home page and list the
  menu's top-level destinations - including the nodes the theme marks as
  special, and a menu embedded in a script or attribute rather than in anchors.
  Each one must be queued or deliberately dropped. A section reachable only
  through the menu is invisible in the report above when the sitemap omits it
  too.
- **The vouches.** A vouched url skips validation entirely, so it is the one
  place a crawler can hide a page from every check:

  ```sql
  select url, type, data from url where site_id = <id> and data is not null
  ```

  Sample a few against the saved snapshot or `jscrawl_webfetch_readonly`. A vouch
  is sound only when the page positively identifies itself (a CMS layout marker,
  a document template). Vouches granted because *nothing matched* are how a soft
  error served with HTTP 200, a login wall or a redesigned page gets filed as
  "carries nothing" - report those as a crawler bug.

## 3. Confirm a suspect before reporting it

A suspect is a candidate. For a few of each kind call `jscrawl_inspectUrl`
(snapshot path, latest fetch) and `jscrawl_{{inspectTool}}` (saved records), and
compare with the live page as `verify-url` describes.

If its snapshot policy is `off` and no snapshot exists, use the live page and
state that historical evidence is unavailable; absence of a snapshot is expected.

A failed page: `fetch failed` is robots, a 403 or a timeout; `scrape failed` is
the crawler throwing, and the error names the expectation that broke. Read it
before blaming the type.

## 4. Report

Lead with the verdict: **complete**, **incomplete** (what is missing, how much),
or **mis-classified** (what is typed wrong). Then:

- coverage: sitemap urls, queued, matched, never queued - and per missing shape,
  gap or correct drop, with the sample url you checked;
- suspects you confirmed, each with its evidence and the rule or selector in
  `crawlers/<site>.ts` to change, and the proposed change;
- what you could not check, and why (no sitemap, partial crawl, page
  unreachable).

When a `[jscrawl]` escalation triggered you, finish with `jscrawl_resolveIssue`
as `verify-url` describes.

## Tools

- `jscrawl_coverage` - the sitemap/type/saved-records diff; start here.
- `jscrawl_inspectUrl`, `jscrawl_{{inspectTool}}` - the crawl's view of one url and what it produced, to confirm a suspect.
- `jscrawl_webfetch_readonly`, `jscrawl_pageProbe` - what a sample url really is
  (unattended triage has `jscrawl_pageProbe_readonly`, which cannot save files).
- `jscrawl_html`, `jscrawl_sql` - the saved snapshot and anything the report does
  not cover.
- `jscrawl_resolveIssue` - an escalated issue's verdict, resolution and status.
