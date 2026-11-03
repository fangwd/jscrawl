---
name: verify-url
description: Verify scraped data for a URL by comparing database records with saved snapshots and the live page, and report discrepancies.
---

# Verify the data scraped from a url

Given a page url (or a numeric url id), check that what the crawler saved matches
the page. This is read-only: investigate and report. Only change the site crawler
when the task explicitly asks for a fix. For a site-level question - did the
crawl cover the site, are urls typed wrongly in bulk - use the `audit-crawl`
skill instead.

## 1. Inspect what was saved

Call `jscrawl_inspectUrl` with the page url. It returns, in one call, the url row and its
status (`2` done, `-1` fetch failed, `-2` scrape failed, `3` excluded by the
site's allow/disallow rules), the site, the latest
fetch (http status / error), the saved HTML snapshot path(s) under `data/html/`,
and the urls the page queued. Then call `jscrawl_{{inspectTool}}` with the same
url for what the page produced: every record the domain saved from it.

Read the status first:
- **No url row** - the page was never queued or crawled. Say so, and whether the
  url classifier should have queued it.
- **status 3** - the site's path rules keep the crawl away from it; not a bug
  unless the rules are wrong.
- **status -1 / -2** - the page failed. Report `latest fetch.error` (and the stack
  trace in `jscrawl.log`). This is a fetch/extractor failure, not a data mismatch.
- **a page of a record-carrying type that saved nothing** - treat it as an
  extractor bug and continue to step 2.

Otherwise, continue: you have the "actual" saved data to compare against the page.

## 2. Re-extract from the saved snapshot (isolates extractor bugs)

`jscrawl_inspectUrl` also reports the page snapshot policy. With `off`, missing
snapshots are expected: compare saved records with a live fetch in step 3 and
state that historical page evidence is unavailable. Existing snapshots remain
usable after disabling storage. The HTML and preview tools read both raw and
gzip snapshots directly; do not decompress them by hand.

The snapshot at `data/html/<id>.<version>` (use the exact path `jscrawl_inspectUrl`
reported) is precisely what the crawler saw. Re-run the site's extractor on it
with `jscrawl_scrapePreview(site, type, file, url)`: it returns the records the
crawler would save, as JSON by table, and writes nothing. `<site>` is the site
name (`select id, name from site`) and `<type>` the url's type from step 1.
A crawler that reads an API or sitemap while scraping fetches it live during
the preview: only the page itself comes from the snapshot.

Diff its tables against what `jscrawl_{{inspectTool}}` showed:

- **Re-extraction == DB, but both wrong vs the page** - the extractor misreads the
  page systematically. Go to step 3, then report an extractor bug.
- **Re-extraction != DB** - the row was saved by an older version of the site
  crawler (it changed since), or the flush was partial. Re-crawling the url
  (`jscrawl_requeueUrl`, or `jscrawl_scrapeUrl` when a fix was asked for) would
  refresh it; note this.

Also check for silent under-extraction: a page can scrape "done" yet miss
whole sections. A visible section with nothing saved is an extractor bug even
though the status is done; name the section and its markup in your resolution.

## 3. Check the live page for drift

The site may have changed since it was crawled. Fetch it fresh and compare the
key fields:

- `jscrawl_webfetch` with `format: "jsonld"` for the page's structured data.
- `jscrawl_webfetch` (html), then the `jscrawl_html` tool with CSS selectors for
  anything not in the structured data. Save the page with `saveTo` if you need
  to query it repeatedly.
- When saved and live data disagree, or the live page looks like an empty
  shell, run `jscrawl_pageProbe <url>`: the site may have moved the data into an XHR /
  API call or a new framework payload. The network list and the embedded-script
  markers show where the data lives now; compare that with what the crawler
  reads, and name the new source in your resolution.

For each field, note the saved value and the value now on the page.

## 4. Report

Lead with the verdict: is the saved data **correct**, **stale** (site drifted), or
**wrong** (extractor bug)? Then, per discrepancy:

- the field, the saved value, and the value the page shows, with the evidence
  (the CSS selector or the structured-data path you read it from);
- the likely cause: extractor bug, site drift, or fetch/scrape failure;
- for an extractor bug, point at `crawlers/<site>.ts` and the specific
  `scrape<Type>` logic, and propose the fix.

Only edit files when the task asks for a fix. If you do, re-run step 2 to confirm
the corrected output, then `jscrawl_validateCrawler` on the snapshot and the
site's fixtures.

## 5. Record the outcome of an escalated issue

When you were triggered by a `[jscrawl] ... (issue #N)` escalation rather than a
human asking, finish by calling `jscrawl_resolveIssue` so the issue leaves the
open queue: the issue id from the escalation message, your verdict, and your
findings, evidence and the **proposed** fix as the resolution - the tool's own
description lists the verdicts and statuses. Do not apply the fix: a human
reviews triaged issues, then applies it or asks for it separately.

## Tools

- `jscrawl_inspectUrl` - the crawl's view of a url (status, fetch, snapshots, queued urls); start here.
- `jscrawl_{{inspectTool}}` - what the url produced: every record saved from it.
- `jscrawl_scrapePreview` - re-run the crawler on the saved snapshot, writing nothing.
- `jscrawl_requeueUrl` - re-scrape one url now ("oneshot") or idle it for the next crawl.
- `jscrawl_coverage` - the site-level audit; see the `audit-crawl` skill.
- `jscrawl_sql` - read-only queries for anything the inspect tools do not cover.
- `jscrawl_webfetch` - re-fetch the live page (`html` or `jsonld`); `saveTo` saves a copy.
- `jscrawl_html` - query a saved page or fixture with CSS selectors.
- `jscrawl_pageProbe` (`jscrawl_pageProbe_readonly` in unattended triage) -
  headless-browser view of the live page: network JSON, embedded
  state scripts, framework hints; use it when the data seems to have moved.
- `jscrawl_validateCrawler` - typecheck, rule check and fixture run after a fix.
- `jscrawl_resolveIssue` - record an escalated issue's verdict, resolution and status
  (the only write these tools allow).

See the `new-site` skill for the site crawler API and extraction helpers, and
`audit-crawl` for a whole site's coverage and url types.
