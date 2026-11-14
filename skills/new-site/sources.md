# Sources: where a page's data lives

Step 3 of the skill finds the values you read off a page in its saved source
with `jscrawl_locate`. This file is for what that does not settle: data that
arrives after the page loads, choosing between several sources, and fetching
through a proxy.

## Probe the live page

Saved HTML shows what the _server_ sent; the data you need may arrive later or
live outside the DOM. When `jscrawl_locate` leaves values unfound, or finds them
only in the rendered DOM, run `jscrawl_pageProbe <url>` on the page. It reports
the data the page fetched over the network (JSON, and the HTML or text fragments
its scripts load, with method, request body and the page's own request headers), inline
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
the url-shape research of step 2 reduces to the page you were given, and the only
HTML fixture needed is that page.

Save a confirmed JSON endpoint with `jscrawl_webfetch` (`format: "json"`,
`saveTo: "crawlers/fixtures/<site>/detail.json"`), then pass it to
`jscrawl_locate` in `json` with the values you read: it lists the path of each.
Use `jscrawl_json` on that file to inspect the exact fields you will consume,
such as `options.0` and `images.0`.

## The order to prefer sources in

Then choose the cheapest source that carries the data, in this order:

1. **A static JSON/API endpoint** from the network list. Confirm with
   `jscrawl_webfetch <that url>` (plus its `method`/`body` for a POST) that it
   answers without a browser (no cookies/JS needed). If it does, fetch and
   parse it in the crawler - stable, small, fast.
2. **Embedded state** in an inline script that `jscrawl_pageProbe` marks as parsing:
   `embeddedJson(doc, 'window.X =')` in the crawler. Typical for Next.js
   (`__NEXT_DATA__`), Nuxt (`__NUXT_DATA__`), SSR hydration blobs, theme
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

| Framework             | First places to look                                                                    |
| --------------------- | --------------------------------------------------------------------------------------- |
| Next.js               | `__NEXT_DATA__` JSON script; `/api/` route XHRs; RSC payloads in the network list       |
| Nuxt / Vue            | `__NUXT_DATA__` / `window.__NUXT__`; Pinia hydration script; `/api/_/` XHRs             |
| Angular               | server-rendered markup, or XHRs to `/api/`; `ng-version` attribute                      |
| React SPA             | XHR / GraphQL endpoints in the network list; else rendered DOM                          |
| WordPress             | server-rendered markup + JSON-LD; `wp-json/` REST (often authenticated); generator meta |
| PHP / server-rendered | DOM selectors + JSON-LD; probes usually show no XHR data                                |

Keep the response from the static confirmation above as evidence. If the endpoint
only works inside the browser, prefer embedded state or the rendered DOM instead.

When the request says the site shows different prices or products by country,
set `proxy: { type, country }` in the site config before fetching - `type` one
the deployment's proxy provider offers (its instructions name them), `country`
the request's: the crawl then goes out through a proxy in that country. Pass
`site` to `jscrawl_webfetch` and `jscrawl_pageProbe` until the crawler is
registered, so what you study is what the crawl will see; after that, the
site's urls go through its proxy on their own.
