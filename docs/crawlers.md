# Writing site crawlers

[Documentation index](README.md) · [Configuration](configuration.md) · [CLI](cli.md)

If you already have a domain app, adding a site usually means adding one module
and saved test pages. If you need the app itself, start with
[Getting started](getting-started.md).

## The site module

Site names use lowercase letters, digits and dashes, starting with a letter or
digit. A module such as `crawlers/example.ts` exports a default crawler class,
an optional `SEED_URL` and an optional `site` configuration object:

```ts
import type { SiteConfig } from 'jscrawl/models';

// Uses the domain class created in the getting-started guide.
import { PageCrawler } from '../src/domain';

export const SEED_URL = 'https://example.com/';
export const site: SiteConfig = {
  waitTime: 1,
  pageSnapshots: 'gzip',
  scope: 'Public documentation pages',
  disallow: ['/search', '/login'],
};

export default class extends PageCrawler {}
```

The default sites directory is `crawlers/` beneath the app's working directory.
Configure another location with `sites.dir` or `JSCRAWL_SITES_DIR`. Shared helpers
can live in `crawlers/lib/`; only top-level `.ts` and `.js` site modules are
enumerated for registration.

Register after creating or changing the module:

```sh
npm run jscrawl -- --setup example
```

Registration updates exported settings and queues the seed if it is new. It does
not reset an already processed seed. A second crawler with an overlapping seed
on the same host is refused; extend the existing crawler instead. Separate
storefront paths such as `/au/` and `/nz/` can be separate sites.

## Dispatch and discover URLs

Declare custom types in `DomainConfig.urlTypes`, then implement handlers with
matching names. For example, `page` dispatches to `scrapePage(doc)` and `category`
to `scrapeCategory(doc)`. Every crawler needs a handler for `seed`, normally
`scrapeSeed(doc)`. The core's `image` type is excluded from normal crawl dispatch.

During a handler you have:

| Property        | Contents                                         |
| --------------- | ------------------------------------------------ |
| `this.doc`      | Parsed HTML document                             |
| `this.response` | Fetch response, including the final URL and body |
| `this.siteUrl`  | Queue record for this page                       |
| `this.db`       | Domain database and buffered record methods      |
| `this.options`  | Registered crawler settings                      |

Queue a link with:

```ts
this.db.addUrl('/docs/intro', 'page', this.siteUrl.id);
```

Relative links resolve against the response's final URL. Fragments are removed;
invalid URLs and non-HTTP schemes are rejected. The third argument records the
link graph's source page; use `null` when there is no source.

Choose the site's host and path boundaries in your discovery logic. `addUrl()`
does not enforce same-origin links for you. It also does not collapse different
query strings or all equivalent URL spellings, so avoid queuing unnecessary
tracking and navigation variants.

The first known type of a URL is preserved when another page links to it. If
content proves the guessed type wrong, scrape it with the appropriate handler
and correct it explicitly:

```ts
this.db.retypeUrl(this.siteUrl, 'page');
```

Pass `this.siteUrl` so validation uses the corrected type during the same pass.
The type must be declared by the domain.

## Extract HTML and structured data

Handlers receive a `gumbo-html` `XDocument`. Use DOM selectors, JSON-LD, embedded
state or a site's data API according to what actually contains the data.

```ts
import { jsonLd, findType, specPairs, imageUrl } from 'jscrawl/extract';

// Inside an async handler receiving doc:
const product = findType(jsonLd(doc), 'Product');
const specs = specPairs(doc);
const image = doc.first('img');
const source = image ? imageUrl(image) : undefined;
```

Useful extraction exports include:

| Helper                         | Use                                                                       |
| ------------------------------ | ------------------------------------------------------------------------- |
| `jsonLd`, `findType`, `isType` | Read and find typed JSON-LD nodes                                         |
| `embeddedJson`, `jsonFragment` | Read JSON from embedded script text                                       |
| `breadcrumbs`                  | Read breadcrumb structure                                                 |
| `specPairs`, `specSections`    | Read name/value specifications and sectioned tables                       |
| `imageUrl`                     | Choose a srcset or lazy-loaded image URL; relative values remain relative |
| `visibleText`, `htmlText`      | Normalize visible text or read an HTML fragment                           |
| `decodeEntities`               | Decode raw escaped text; DOM text and attributes are already decoded      |

For extra API or sitemap requests, use `this.fetch()` so requests follow the
site's pacing, robots policy and proxy, and can be recorded for replay:

```ts
const response = await this.fetch('https://example.com/api/pages');
const data = JSON.parse(response.text());
```

It also supports `{ method: 'POST', headers: {...}, body: JSON.stringify(...) }`.
For non-HTML responses, override `scrape(response, url)` and manage dispatch and
state deliberately; the default implementation parses the response as HTML.

Enable `site.usePuppeteer` when the main page must be rendered. Additional
`this.fetch()` calls still use plain HTTP.

## Test extraction with saved pages

Keep fixtures beside the crawler in `crawlers/fixtures/<site>/`. A manifest at
`pages.json` lists the page types and URLs:

```json
[
  { "type": "seed", "file": "home.html", "url": "https://example.com/" },
  { "type": "page", "file": "intro.html", "url": "https://example.com/docs/intro" }
]
```

Files are relative to the manifest directory. Types must be `seed` or domain
types. Domains may require additional fields through `DomainConfig.fixtures`;
the manifest rejects undeclared fields.

Preview one page from the terminal:

```sh
npm run jscrawl -- --scrape-file example page crawlers/fixtures/example/intro.html --url https://example.com/docs/intro
```

Previews buffer records without flushing them, but still connect to a database
with the schema installed. Extra handler requests replay from `<file>.fetches/`
when recorded responses exist. Missing responses can cause live requests and
create replay files, so preserve those files for repeatable checks.

With an MCP client, use `dryRun` for several pages and `validateCrawler` for
typechecking, crawler rule checks and domain fixture checks. `checkCrawler`
loads the site's manifest for you. A preview alone does not run all those checks.
See [MCP workflows](mcp.md#typical-workflows).

After verifying the crawler, register it and start a crawl. Re-run previews and
validation after edits. Inspect coverage and saved records as well as URL success
counts: a successful fetch does not prove that extraction is complete.
