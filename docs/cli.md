# CLI reference

[Documentation index](README.md) · [Getting started](getting-started.md)

These examples use the `jscrawl` npm script from the quickstart. Your app's
`src/cli.ts` registers its domain, then calls `runCli()` from
`jscrawl/entries/cli`. Run commands from the app root so configuration and site
paths resolve correctly.

```sh
npm run jscrawl -- --help
```

Use one command flag per invocation. Supply URLs as absolute HTTP or HTTPS
addresses. Commands such as `--fetch` and `--scrape-url` expect a URL already in
the database; they do not discover and register a new site.

## Register sites

```sh
npm run jscrawl -- --setup example
npm run jscrawl -- --sync
```

`--setup <site>` registers or updates one module and queues its `SEED_URL` if
new. `--sync` registers all site modules and identifies database sites whose
modules are gone.

**Sync can permanently delete missing sites, their crawled records and their
fixture directories.** It lists what would be removed and asks for confirmation
in an interactive terminal. `--sync --yes` skips that question. Without a terminal
or `--yes`, removal is declined. A site with a live run is not removed.

CLI `--sync` is different from the server's automatic Git checkout sync, which
brings merged crawler source from `origin/main`.

## Crawl and recrawl

```sh
npm run jscrawl -- --crawl example
```

Processes idle seed and domain URLs until the queue drains. This records a run
and heartbeat. The first Ctrl+C or SIGTERM requests a stop after the current
page. Re-running the command continues remaining idle work.

To fetch processed pages again, reset the site before crawling:

```sh
npm run jscrawl -- --reset example
npm run jscrawl -- --crawl example
```

`--reset` sets **all** of the site's URL statuses to idle, including busy URLs.
Stop a running crawl before using this command. The HTTP reset endpoint is more
selective and leaves busy URLs alone; see [HTTP API](http-api.md).

A crawl that stops after repeated fetch refusals exits with code **75** and
records a blocked run. See [Troubleshooting](operations.md#troubleshooting).

## Queue URLs

```sh
npm run jscrawl -- --add-url https://example.com/docs/intro --kind page
```

`--kind` must be `seed`, `image` or a type your domain declares. The first URL
selects the registered site by its seed; queue URLs for that same site together.
An explicit kind also corrects the type of an already queued URL. Adding a URL
does not reset its status or start a crawl.

For a JSON array such as `[{"url":"https://example.com/docs/intro"}]`:

```sh
npm run jscrawl -- --add-urls urls.json --site example --kind page --regex '/docs/' --priority 1
```

All four options are required. Matching entries are queued for the named site;
larger priorities are claimed first.

## Preview a saved page

```sh
npm run jscrawl -- --scrape-file example page crawlers/fixtures/example/intro.html --url https://example.com/docs/intro
```

Accepts raw HTML/JSON or a saved response container and prints the records the
crawler buffers, without flushing them. It needs a database with the schema
installed, but the site need not already be registered. Give `--url` for relative
link resolution; otherwise it uses `https://example.invalid/page`.

Additional handler requests can fetch and save replay files if those files do
not already exist. This command is a record preview, not the full fixture
validation workflow described in [MCP tools](mcp.md).

## Fetch or scrape queued URLs

```sh
npm run jscrawl -- --fetch https://example.com/docs/intro
npm run jscrawl -- --scrape-url https://example.com/docs/intro
```

Both commands fetch the queued URL, save its response when configured, and update
its status and fetch history. `--fetch` skips extraction; `--scrape-url` also
extracts and writes records. Stop competing work on the page before running a
terminal one-shot; the supervisor's HTTP/MCP controls coordinate live runs.

## Replay a crawl response

```sh
npm run jscrawl -- --scrape data/html/42.0
npm run jscrawl -- --scrape data/html/42.0 --flush
npm run jscrawl -- --html data/html/42.0 page.html
```

`--scrape` loads jscrawl response containers, finds each queued URL and re-runs
extraction. By default it discards buffered records and prints no record preview;
use `--scrape-file` when you want to see the records. `--flush` persists replayed
records. Replay does not run the full fetch/status/validation lifecycle.

`--html <response> <output>` writes the response body to a plain file. A response
container is different from raw HTML, even when snapshot mode is `raw`.

## Optional domain features

```sh
npm run jscrawl -- --export-feed example exports/example.zip
npm run jscrawl -- --live-check 42 live-check.json
```

`--export-feed` requires `DomainConfig.feed`; bytes and format are domain-defined.
`--live-check` requires `DomainConfig.liveCheck`. It fetches a queued URL by
numeric ID, previews extraction and writes a diff against saved domain records,
without replacing those records.
