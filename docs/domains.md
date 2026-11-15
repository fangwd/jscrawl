# Domains and records

[Documentation index](README.md) · [Complete example](getting-started.md)

A domain is the contract between your app and jscrawl. It defines what pages can
produce, while site crawlers supply website-specific extraction. Register one
`DomainConfig` with `useDomain()` in every entry process before creating crawlers,
loading schemas or starting services. Import from `jscrawl/domain`.

## DomainConfig reference

The full typed contract is in [domain.ts](../src/core/domain.ts).

| Required field                             | Purpose                                                                   |
| ------------------------------------------ | ------------------------------------------------------------------------- |
| `name`                                     | Domain name reported by `/api/domain` and recorded in schema versions     |
| `urlTypes`                                 | Additional queue types; `seed` and `image` already belong to the core     |
| `schema`                                   | Absolute schema file paths, migration paths and the domain schema version |
| `database`                                 | A `CoreDatabase` subclass with your record write methods                  |
| `crawler`                                  | The domain's base `Crawler` subclass                                      |
| `expectations.parse(raw, siteName)`        | Validate and normalize a module's `site.expect`; throw for invalid input  |
| `expectations.shortfalls(expect, metrics)` | Return findings when a completed crawl misses expectations                |
| `metrics(siteId, db)`                      | Return named numeric counts for a site's records                          |
| `metricRules`                              | Metric labels and optional regression thresholds                          |
| `api`                                      | sqlex API resources and optional defaults mounted under `/api/d/`         |
| `inspectTool`                              | Name of a tool that reads saved records for a page                        |

Although `tools` is optional in the interface, starting the MCP server requires
it to provide the named `inspectTool`. Domain tool names must not collide with
core tool names. See [Adding domain tools](mcp.md#adding-domain-tools).

| Optional extension            | Purpose                                                                        |
| ----------------------------- | ------------------------------------------------------------------------------ |
| `fixtures`                    | Extra manifest fields, fixture listing checks and per-page extraction checks   |
| `expectations.pageShortfalls` | Check preview tables against fields expected on each page type                 |
| `reading`                     | Fields the page-reading tools should inspect for each page type                |
| `suspects`                    | Coverage candidates whose saved type may contradict their content              |
| `pageGone(url, db)`           | Update domain records when a page returns 404 or 410                           |
| `tools`                       | Domain MCP tools alongside the core's tools                                    |
| `skills`                      | Domain skill directory and additional agent instructions                       |
| `ui`                          | Navigation, model display, money and metric hints for a separate dashboard     |
| `liveCheck`                   | Tables and row matching keys for comparing a live scrape with saved data       |
| `feed`                        | Export bytes, filename, content type and an optional Markdown format reference |

## Store records through a database subclass

Extend `CoreDatabase` from `jscrawl/base-database`. Add typed methods that call
`this.table('your_table').append(...)`, using sqlex field names such as `site`
and `url` for foreign keys rather than SQL column names such as `site_id`.

`append()` buffers a record. The engine calls `flush()` after scraping a page and
then clears the buffers. Unique constraints determine record identity, so define
them deliberately: the quickstart uses a unique `url_id` for one page per URL.

Handlers should buffer writes and let the engine flush them. When extraction
throws, buffered changes are cleared before the engine records the failure.
Direct SQL writes inside a handler happen immediately and do not get this
buffer rollback behavior.

`this.db.urlFetch` refers to the current fetch record if your domain needs to
link observations to the fetch that produced them. Extend these lifecycle
methods if your database carries additional state:

- `init(name)` loads site-specific state.
- `clone()` creates a handle for another fetch loop; carry your state across it.
- `flush(options)` writes buffered records; use appropriate sqlex options for
  child records that a page replaces, then do domain bookkeeping after it resolves.
- `clear()` clears buffers and resets per-page state.

Call the base implementation when overriding these methods. A fresh scrape does
not automatically remove every old domain row: replacement, stale children and
disappeared pages need explicit domain behavior.

## Validate pages and complete crawls

Override `validate(url): Promise<Finding[]>` on the domain crawler to check the
records just saved. A finding is `{ code: string, detail: string }`. Use stable
codes: jscrawl groups issues by the site, page type, issue kind and finding codes.
Return `[]` when the page is valid. See the
[test domain](../test/support/domain.ts) for a saved-record validation example.

Page validation runs after a successful scrape has been flushed. Validation
findings create `validation` issues; an exception during extraction creates a
`scrape_failed` issue. Reporting an issue does not itself fail the whole crawl.

After a pass that drains its queue without a stop request, jscrawl:

1. Records `metrics()` in a crawl snapshot and compares them with the previous
   complete pass using `metricRules`.
2. Checks the site's parsed `expect` against those metrics.

A stopped pass does not run these complete-crawl checks. The quickstart's
expectations are no-ops; implement them before relying on `site.expect`.

```ts
const metricRules = {
  pages: { label: 'pages', regression: { kind: 'drop' as const, percent: 20 } },
  titled: {
    label: 'pages with a title',
    regression: { kind: 'share' as const, of: 'pages', points: 10 },
  },
};
```

The first rule checks a relative drop in a count. The second checks a drop in the
metric's share of another metric, measured in percentage points.

## Evolve schemas

Core SQL loads before domain SQL. Domain tables should reference `site.id` and
`url.id` where appropriate. Resolve file paths from your domain module so they
do not depend on where a child process happens to load them.

Supply re-runnable migration files, update `schema.version` as your schema evolves
and keep fresh-install schema files in sync. The migration runner executes all
configured migration files on each run; it does not skip individual files based
on the version. A database version newer than the running code is refused.
See [Database migrations](operations.md#database-migrations) before initializing
or upgrading a database.
