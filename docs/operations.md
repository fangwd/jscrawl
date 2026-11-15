# Operations and troubleshooting

[Documentation index](README.md) · [Configuration](configuration.md) · [HTTP API](http-api.md)

## Run the service

The standard `runServer()` entry migrates the existing database, initializes the
crawl supervisor, starts the HTTP server and launches the MCP tool-server child.
Create the initial schema before the first server start. Run from the app root
with `ts-node` installed and the entry files at `src/cli.ts` and
`src/mcp/server.ts`, as shown in [Getting started](getting-started.md).

The server defaults to loopback. Calls to `/api/` and `/mcp` need the service
token; `/healthz` reports readiness without authentication. An external dashboard
or service can consume the API. jscrawl itself does not serve a dashboard.

On SIGINT or SIGTERM the server stops its children and closes its proxy pool.
Terminal crawls also track runs and heartbeats, allowing the service to discover
their live work and release claims after a run is over.

## Scheduled crawls and source sync

Export a `site.refresh` duration, register the module and start its first crawl
manually. The running server checks scheduled work at startup and every five
minutes. Intervals are measured from the last crawl's **start**, so scheduling
is approximate rather than a precise cron time.

The scheduler resets processed URLs and starts eligible due sites. It skips
sites that have never been crawled, have a live crawl or are held for review.
An original `triaged` issue awaiting review holds its site, regardless of issue
kind. Copies of another issue do not create an additional hold. Review the
finding and update its status before restarting normal scheduled work.

Before each scheduling check, the server attempts to fast-forward the crawlers
checkout to `origin/main`. This requires a crawlers Git repository. Sync waits
if the checkout is on another branch, has divergent commits or has conflicting
local edits. Local modules work without a remote; automatic Git sync is separate
from CLI `--sync`, which registers modules and can delete stale sites.

## Saved responses and replay

With `store.html` configured and `pageSnapshots` enabled, textual and JSON page
responses are stored under:

```text
data/html/<url-id>.<version>
data/html/<url-id>.<version>.fetches/<request-hash>
```

The version in the filename is the queue record's version before that fetch;
processing increments the stored version. Read URL details to find available
snapshots rather than assuming the current version names a file.

`gzip` and `raw` select compression of the response container. Neither is just
a plain HTML file. `off` disables main-page response snapshots. These snapshots
support inspection and replay; they do not cache normal crawl requests.

Additional `this.fetch()` responses are recorded in the `.fetches` directory and
replayed when present. Preserve that directory with fixtures. A missing response
can trigger a live fetch during a preview. Use `--html` to extract a container's
body and `--scrape-file` to preview extraction; see [CLI](cli.md).

Back up PostgreSQL and saved-page storage together if you need both records and
their source evidence. jscrawl does not configure snapshot retention for you.

## Runs, URL statuses and issues

Runs represent processes, with kind `crawl` or `oneshot`. Their status can be
`running`, `stopped`, `blocked`, `crashed` or `interrupted`. `stopped` also covers a
normal process exit after the queue drains; use run details, fetches and queue
counts to assess what work finished.

| URL status | Name           | Meaning                                                        |
| ---------- | -------------- | -------------------------------------------------------------- |
| `-2`       | `ScrapeFailed` | Extraction threw                                               |
| `-1`       | `FetchFailed`  | Fetch failed or returned a non-200 response                    |
| `0`        | `Idle`         | Available for a crawl to claim                                 |
| `1`        | `Busy`         | Claimed by a crawl                                             |
| `2`        | `Done`         | Processed successfully; inspect records for extraction quality |
| `3`        | `Disallowed`   | Excluded by crawler path rules or robots.txt                   |

Fetches record transport errors, HTTP status, timing, final URL and content
metadata. A 404 or 410 invokes the optional domain `pageGone` hook; how records
are retired depends on the domain.

Issues distinguish extraction exceptions (`scrape_failed`), saved-record checks
(`validation`), unmet site expectations (`acceptance`), metric drops (`regression`)
and repeated fetch failures (`blocked`). Issue states are `open`, `triaged`,
`resolved` and `ignored`. The API supports human status overrides; the MCP
`resolveIssue` tool records classification and investigation findings.

## Database migrations

Use the app scripts from the quickstart:

```sh
npm run db:schema
```

**This rebuilds core and domain tables and drops existing data. Use it only when
initializing a new database or deliberately replacing a disposable one.**

For an existing installation:

```sh
npm run db:migrate
```

The migration runner applies additive core migrations followed by the domain's
configured migrations, then records versions in `schema_version`. The standard
server also runs migrations on startup. Domain migration files must be safe to
re-run. A migration pass upgrades an existing schema; it does not replace fresh
schema loading on an empty database.

If a stored core or domain schema version is newer than the running build,
migration refuses to proceed. Upgrade the code to a compatible version instead
of lowering the database version. Back up data before a deployment that changes
the schema.

## Troubleshooting

| Symptom                            | Check and next action                                                                                                                   |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `No domain registered`             | Import the registration module before calling any entry function, including in child entries                                            |
| Missing `etc/config.json`          | Run from the app root or set `JSCRAWL_CONFIG`; `DATABASE_URL` does not replace the JSON file                                            |
| Missing `.env` on server startup   | Create the file; the standard server loads it unconditionally                                                                           |
| Database connection refused        | Check PostgreSQL readiness, host/port and the `DATABASE_URL` override                                                                   |
| Missing tables                     | Initialize a new database with the schema command; migrate an existing installation                                                     |
| `No crawler` or no site modules    | Check `sites.dir`, `JSCRAWL_SITES_DIR`, module names and the app working directory                                                      |
| Crawl exits without fetching pages | Check idle queue counts; setup does not reset completed seeds, and restart does not reset completed URLs                                |
| Crawl pauses near the end          | Each fetch loop waits up to about 50 seconds for more discovered URLs before exiting                                                    |
| Unknown type or missing handler    | Declare types in `DomainConfig.urlTypes` and implement `scrape<Type>`                                                                   |
| Preview fails before extraction    | Previews still need a database and schema; check those connections first                                                                |
| Empty extracted records            | Inspect raw and rendered sources, then preview representative fixtures and check the handler's selectors/data source                    |
| Disallowed URLs                    | Check crawler path rules and robots.txt; reset after changing rules to request another evaluation                                       |
| robots.txt unreachable             | A 5xx or transport error prevents host requests; its policy can be retried after one minute                                             |
| HTTP 401                           | Send the exact service token in `Authorization: Bearer ...`                                                                             |
| HTTP 503 / MCP unavailable         | Check the tool child logs, its entry path, token and domain inspect tool                                                                |
| Run exits with code 75             | Twenty consecutive page fetch failures/refusals stop the crawl as blocked; investigate availability, responses, pacing and proxy health |
| Restart or schedule refused        | Check live runs and original triaged issues awaiting review                                                                             |
| New thread count has no effect     | Change the site's database setting through the API; module `threadCount` initializes new sites only                                     |
| No feed or live-check feature      | Implement the corresponding optional domain hook; inspect `/api/domain`                                                                 |

For a failed crawl, begin with `/api/crawlers/<site>/log?tail=1` and
`/api/runs/<id>/fetches?failed=1`, then inspect the affected URL and saved response.
Supervisor logs live in `data/logs/<encoded-database-name>/`; terminal crawler
logging also uses the working directory's `jscrawl.log`.
