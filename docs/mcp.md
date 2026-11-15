# MCP tools

[Documentation index](README.md) · [HTTP API](http-api.md)

jscrawl serves its core and domain tools through MCP Streamable HTTP at `/mcp`.
The main server forwards requests to a supervised child tool server, isolating
crawler execution and typechecks from the API process.

## Connect a client

Start the app as described in [Getting started](getting-started.md). Configure
your MCP client with:

```text
Transport: Streamable HTTP
URL: http://127.0.0.1:3120/mcp
Authorization header: Bearer <the value of JSCRAWL_API_TOKEN>
```

Client configuration formats differ; those are the connection values to supply.
The endpoint is stateless, accepts POST requests, and does not require session
affinity. `GET /healthz` on the main server reports whether the child is ready.

Tools are registered under names such as `scrapePreview` and `crawlStart`. Some
clients namespace them as `jscrawl_scrapePreview`; use the names your client's
tool listing reports. The tool listing is also the source of exact argument
schemas and descriptions.

## Tool reference

| Task                                     | Tools                                                                |
| ---------------------------------------- | -------------------------------------------------------------------- |
| Fetch and inspect source                 | `webfetch`, `webfetch_readonly`, `html`, `json`                      |
| Inspect rendered pages and data requests | `pageProbe`, `pageProbe_readonly`, `pageRead`                        |
| Discover structure and locate values     | `siteSurvey`, `locate`, `classifierCheck`                            |
| Inspect the database and saved pages     | `dbSchema`, `sql`, `inspectUrl`, the domain's inspect tool           |
| Preview extraction                       | `scrapePreview`, `dryRun`                                            |
| Validate source and fixtures             | `validateCrawler`, `checkCrawler`                                    |
| Assess completed data                    | `coverage`, `checkExpectations`, `crawlHistory`                      |
| Register and scrape                      | `populate`, `scrapeUrl`, `requeueUrl`                                |
| Control and monitor crawls               | `crawlStatus`, `crawlStart`, `crawlStop`, `crawlRestart`, `crawlLog` |
| Classify issues                          | `resolveIssue`                                                       |
| Submit crawler source for review         | `submitCrawler`                                                      |
| Export domain data, when supported       | `exportFeed`                                                         |

The `_readonly` fetch/probe variants are intended for inspection without saved
page output. Read-only annotations describe tool intent; preview tools may still
make network requests or write replay files when handler responses are missing.

## Typical workflows

For a new site:

1. Read the deployment's skills from `GET /api/skills`. The bundled
   [new-site skill](../skills/new-site/SKILL.md) describes discovery, source
   selection and crawler conventions.
2. Use `siteSurvey`, `webfetch` and `pageProbe` to understand navigation, data
   sources and page types. Save representative pages beneath the site's fixture
   directory.
3. Implement the crawler, then use `scrapePreview` for quick feedback or `dryRun`
   for several pages. Check records, not just whether handlers finish.
4. Run `validateCrawler` after the final edit, or `checkCrawler` with the site
   file to load its `pages.json`. These combine typechecking, crawler rule checks
   and fixture execution. Domains can add contract checks.
5. Run `populate` to register modules and queue seeds, then `crawlStart` for the
   chosen site. `populate` does not perform CLI sync's stale-site deletion.
6. Use `coverage`, `checkExpectations` and the domain inspect tool to assess the
   saved result.

Example `scrapePreview` arguments:

```json
{
  "site": "example",
  "type": "page",
  "file": "crawlers/fixtures/example/intro.html",
  "url": "https://example.com/docs/intro",
  "limit": 10
}
```

Example `dryRun` or `validateCrawler` arguments:

```json
{
  "site": "example",
  "pages": [
    {
      "type": "page",
      "file": "crawlers/fixtures/example/intro.html",
      "url": "https://example.com/docs/intro"
    }
  ],
  "tables": ["page"],
  "limit": 10
}
```

For an existing problem, start with `inspectUrl`, the domain inspect tool, source
inspection and a saved-page preview. Classify findings through `resolveIssue`;
that records a verdict and proposed resolution rather than applying a code fix.
The [audit-crawl](../skills/audit-crawl/SKILL.md) and
[verify-url](../skills/verify-url/SKILL.md) skills describe those workflows.

`submitCrawler` is an explicit publishing step: it commits and pushes the site's
crawler, manifest, listed pages and handler replay files to a `crawler/<site>`
branch and opens or updates a pull request. It requires a separate crawlers Git
repository with `origin/main` and an authenticated GitHub CLI. A local crawl does
not require this workflow.

## Adding domain tools

Return `DomainTool[]` from `DomainConfig.tools(deps)`. A tool supplies a name,
description, Zod raw argument shape, optional `readOnly` flag and an async
`execute(args, context)` returning text. The context includes `cwd`, an abort
signal and optional image attachment support.

Import types from `jscrawl/mcp/tools`. Dependencies provide the database,
configuration, app directory, API URL and token. Domain tools cannot reuse core
names, and the domain must provide the tool named by `inspectTool`. The
[quickstart domain](getting-started.md#3-define-the-page-table-and-domain) includes
a minimal `inspectPage` implementation.
