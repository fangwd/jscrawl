# Site settings

What `site` in `crawlers/<name>.ts` holds beyond the seed: pacing, the part of
the site to crawl, what a finished crawl must hold, and how often to repeat it.

## Pacing and robots.txt

Keep the template's pacing (`waitTime`, `randomWait`) and leave `threadCount`
at its default of one; the core also waits at least the `Crawl-delay` the
site's robots.txt asks for. Raise none of these unless the user asks. The
wait is between any two requests to the site, whichever thread sends them.
`threadCount` is read only when the site is first registered; after that the
site row's `thread_count` is what a crawl runs with.

The core obeys each host's robots.txt for every request a crawl makes, pages
and `this.fetch` calls alike: a page it disallows is recorded as disallowed
and never fetched, a handler fetch it disallows fails the scrape, and while a
host's robots.txt cannot be served (5xx, no answer) nothing is fetched from it.
Path rules can narrow a crawl further but cannot open what robots.txt closes.

## Keeping a crawl to part of a site

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

## What the request promises

Set `site.expect` to record what a finished crawl must hold, in the domain's
terms (its part of this skill says which), so the
build and every complete crawl are checked against the request, not against
whatever the crawler happens to save. After each complete crawl the server
checks the site against it and raises an acceptance issue for a shortfall;
`jscrawl_checkExpectations` shows the numbers. An expectation the site cannot
meet is a finding to report, not a reason to loosen it until it passes.

## Refresh and page snapshots

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
should not be retained; fetch metadata, extracted records and validation still
work, but historical page comparisons need an existing snapshot. Keep a few
explicit fixtures for testing.
Run `jscrawl_populate` after changing this setting, then restart an active crawl.
The tool reports the registered policy; `jscrawl_inspectUrl` reports it too.
