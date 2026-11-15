# HTTP API

[Documentation index](README.md) · [Server setup](getting-started.md#4-add-the-entry-files-and-a-site)

The standard server listens at `http://127.0.0.1:3120`. It provides crawl control,
inspection, domain records and MCP forwarding. Configure the host, port and token
through [environment variables](configuration.md#environment-variables).

## Authentication and request format

All `/api/` and `/mcp` requests require the service token:

```sh
curl -H "Authorization: Bearer $JSCRAWL_API_TOKEN" \
  http://127.0.0.1:3120/api/overview
```

Supply `Content-Type: application/json` for JSON mutations. `GET /healthz` needs
no token and reports readiness through the tool server. While that child is
starting or unavailable it returns 503.

The token grants service access, including writes and crawler source edits; it
is not a per-user login. Keep it in your backend when building a separate UI.

Most responses are JSON. Errors include an `error` field. Common statuses are
400 for invalid input, 401 for missing/incorrect credentials, 404 for missing
resources, 409 for conflicting run or edit state, and 415 for a required JSON
content type. Domain exports can return files rather than JSON.

## Read endpoints

`<id>` below is numeric. `<site>` on crawler routes accepts a numeric site ID or
exact registered name.

| GET path                                    | Returns / useful parameters                                                      |
| ------------------------------------------- | -------------------------------------------------------------------------------- |
| `/healthz`                                  | Tool-server readiness and tool count; no authentication                          |
| `/api/domain`                               | Domain name, page types, optional features and UI hints                          |
| `/api/overview`                             | Sites, URL status counts and open issue totals                                   |
| `/api/sites/<id>`                           | Site details and metrics                                                         |
| `/api/sites/<id>/urls`                      | URLs; `type`, `status`, `q`, `page`, `pageSize`                                  |
| `/api/sites/<id>/crawler`                   | Crawler source and hash for editing                                              |
| `/api/urls`                                 | URLs; `siteId`, `type`, `excludeType`, `status`, `q`, `page`, `pageSize`         |
| `/api/urls/<id>`                            | URL details, fetch history and saved-page information                            |
| `/api/urls/<id>/snapshot/<version>`         | Saved response body, served with a sandbox policy                                |
| `/api/crawlers`                             | Crawler status overview                                                          |
| `/api/crawlers/<site>/runs`                 | Runs for the site                                                                |
| `/api/crawlers/<site>/log`                  | Log; `runId`, `tail=1`, or byte `offset` and `limit`                             |
| `/api/runs`                                 | Runs; `siteId`, `status`, `kind`, `page`, `pageSize`                             |
| `/api/runs/<id>`                            | Run details                                                                      |
| `/api/runs/<id>/fetches`                    | Run fetches; `failed=1`, `page`, `pageSize`                                      |
| `/api/runs/<id>/process`                    | Local live process information, or why unavailable                               |
| `/api/issues`                               | Issues; `siteId`, `status`, `verdict`, `kind`, `originals=1`, `page`, `pageSize` |
| `/api/issues/<id>`                          | Issue details                                                                    |
| `/api/problems`                             | Grouped open problems                                                            |
| `/api/schema`                               | Database table descriptions                                                      |
| `/api/system`                               | Host, database, storage and running process information                          |
| `/api/proxies`                              | Proxy provider overview                                                          |
| `/api/skills`                               | Core and domain agent instructions and skills                                    |
| `/api/d/openapi.json`                       | Generated OpenAPI document for domain records                                    |
| `/api/sites/<id>/feed.zip`                  | Optional domain export                                                           |
| `/api/docs/feed-format`                     | Optional domain export format reference                                          |
| `/api/sites/<site>/image?url=<encoded-url>` | Fetch a known site image through the site's route                                |

Use `/api/overview` to list sites; there is no collection `GET /api/sites` route.
Core lists use `page` and `pageSize`; the generated domain API has its own query
contract described in its OpenAPI document.

## Control a crawl

```sh
curl -X POST -H "Authorization: Bearer $JSCRAWL_API_TOKEN" \
  http://127.0.0.1:3120/api/crawlers/example/start
```

Start returns `{"runId": ...}` and processes idle URLs. Restart reloads crawler
code and continues the queue; it does not reset completed URLs.

| Method and path                     | JSON body / effect                                         |
| ----------------------------------- | ---------------------------------------------------------- |
| `POST /api/crawlers/<site>/start`   | No body; start idle work                                   |
| `POST /api/crawlers/<site>/stop`    | No body; stop the site's live crawl                        |
| `POST /api/crawlers/<site>/restart` | No body; stop if running, then start                       |
| `POST /api/runs/<id>/stop`          | No body; stop a particular live run                        |
| `POST /api/sites/<site>/reset-urls` | `{ "onlyFailed": true, "dry": true }`; both optional       |
| `POST /api/urls/<id>/rescrape`      | `{ "mode": "queue" }` (default) or `{ "mode": "oneshot" }` |
| `POST /api/urls/<id>/live-check`    | Optional domain live comparison; no body                   |
| `PATCH /api/sites/<id>`             | `{ "threadCount": 2 }`; whole number 1–8                   |

Resetting URLs does not start a crawl. A full reset idles done, disallowed and
failed URLs; `onlyFailed` limits it to negative statuses. Busy URLs are left
alone. Preview the affected count with `dry: true`, then omit `dry` to apply.

```sh
curl -H "Authorization: Bearer $JSCRAWL_API_TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{"onlyFailed":true,"dry":true}' \
  http://127.0.0.1:3120/api/sites/example/reset-urls
```

Rescrape mode `queue` idles a non-busy URL for a crawler to claim; it does not
start one. Mode `oneshot` starts a short-lived child and returns its run ID; it
is refused while that site's crawl is live.

Bulk controls accept `{"dry":true}` to preview their targets:

| POST path                    | Effect when applied                                         |
| ---------------------------- | ----------------------------------------------------------- |
| `/api/crawlers/resume`       | Start remaining idle work for previously run, stopped sites |
| `/api/crawlers/recrawl`      | Reset processed URLs and start eligible sites               |
| `/api/crawlers/reset-failed` | Reset failed URLs and start eligible sites                  |

Sites with a live crawl or a review hold are excluded from starting new work.

## Issues, source edits and SQL

| Method and path                | JSON body                                                                                                 |
| ------------------------------ | --------------------------------------------------------------------------------------------------------- |
| `PATCH /api/issues/<id>`       | `{ "status": "resolved", "note": "Checked the saved output" }`; status is `open`, `resolved` or `ignored` |
| `PUT /api/sites/<id>/crawler`  | `{ "code": "...", "hash": "..." }` from the source GET response                                           |
| `POST /api/sql`                | `{ "query": "select id, name from site order by id" }`                                                    |
| `DELETE /api/proxies/<id>`     | No body; remove a provider proxy                                                                          |
| `POST /api/proxies/<id>/renew` | No body; renew its route                                                                                  |
| `POST /api/proxies/<id>/check` | No body; check connectivity                                                                               |

Source editing uses the hash to reject stale writes with 409; fetch the latest
source before retrying. Saving source does not validate or register it. Use the
fixture workflow and setup/populate afterward.

SQL queries run through the read-only query helper and return at most 1,000 rows.
Use `/api/schema` for real column names. Issue status overrides can propagate to
copies sharing that problem; agent classification is handled by the MCP tool.

## Domain records

Your domain chooses resources under the fixed prefix `/api/d/`. The domain name
does not change that prefix. Read `/api/d/openapi.json` for exact resource paths,
fields, filters, includes and methods. Core `Site` and `Url` resources are exposed
read-only beside domain resources.

Feed and live-check endpoints exist only when the domain implements those
features. Use `/api/domain` to discover availability.
