# Configuration

[Documentation index](README.md) · [Getting started](getting-started.md)

## Application configuration

`loadConfig()` from `jscrawl/config` reads `etc/config.json` by default. Pass a
path explicitly or set `JSCRAWL_CONFIG` to select another file. Paths such as
`store.html` are relative to the app's working directory.

```json
{
  "database": {
    "dialect": "postgres",
    "connection": "postgresql://admin:secret@127.0.0.1:5433/my_crawler"
  },
  "store": {
    "html": "data/html",
    "images": "data/images"
  },
  "sites": { "dir": "crawlers" }
}
```

`database` is a sqlex connection configuration. The connection can also be an
object with `host`, `port`, `user`, `password` and `database`, as shown in the
quickstart. `store.html` and `store.images` are optional paths within the required
`store` object. Without `store.html`, page response snapshots are not saved.

If `.env` exists in the working directory, `loadConfig()` loads it. Already set
environment variables win over `.env`. A `DATABASE_URL` from either source
overrides the JSON database connection and sets its dialect to PostgreSQL. It
must begin with `postgres://` or `postgresql://`. The JSON file is still required
even when the connection is supplied through the environment.

## Environment variables

| Variable               | Default or behavior                                                                     |
| ---------------------- | --------------------------------------------------------------------------------------- |
| `DATABASE_URL`         | Overrides `config.database.connection`                                                  |
| `JSCRAWL_CONFIG`       | `etc/config.json`                                                                       |
| `JSCRAWL_SITES_DIR`    | Sites directory when `config.sites.dir` is absent; otherwise `crawlers/`                |
| `JSCRAWL_API_TOKEN`    | Required by both servers; at least 16 characters; supplied to callers as a bearer token |
| `JSCRAWL_HOST`         | HTTP server bind address, `127.0.0.1`                                                   |
| `JSCRAWL_PORT`         | HTTP server port, `3120`                                                                |
| `JSCRAWL_URL`          | URL tools use to call the API; defaults to `http://127.0.0.1:<JSCRAWL_PORT or 3120>`    |
| `PROXY_PROVIDER_URL`   | Proxy provider service URL when proxying is configured                                  |
| `PROXY_PROVIDER_TOKEN` | Proxy provider bearer token                                                             |
| `JSCRAWL_GH`           | GitHub CLI executable for crawler submission; defaults to `gh`                          |
| `JSCRAWL_RUN_ID`       | Internal run identifier passed to child processes; normally leave unset                 |

The standard HTTP server calls `process.loadEnvFile()` unconditionally, so create
a `.env` file even when a service manager supplies all variables. The tool server
tolerates a missing `.env` file.

## Per-site configuration

Export a `site: SiteConfig` object from the crawler module. Register it with
`--setup <site>` to store changes. Types are defined in
[models.ts](../src/core/models.ts).

| Setting              | Default  | Meaning                                                                             |
| -------------------- | -------- | ----------------------------------------------------------------------------------- |
| `waitTime`           | `0`      | Seconds between request starts                                                      |
| `randomWait`         | `0`      | Extra random seconds, used when `waitTime > 0`                                      |
| `threadCount`        | `1`      | Concurrent fetch loops; initializes a new site only                                 |
| `maxRetryCount`      | `5`      | Retry count for failed requests                                                     |
| `requestTimeout`     | `30`     | Positive whole seconds without an answer while connecting or between response bytes |
| `usePuppeteer`       | `false`  | Render the main page in a browser                                                   |
| `proxy`              | Omitted  | `{ type, country? }`; provider type and optional uppercase two-letter country       |
| `pageSnapshots`      | `'gzip'` | `'gzip'`, `'raw'` or `'off'`                                                        |
| `allow`, `disallow`  | `[]`     | Path rules using robots.txt syntax                                                  |
| `scope`              | Omitted  | Human-readable crawl scope used by coverage and triage                              |
| `refresh`            | Omitted  | Scheduled recrawl interval such as `'30m'`, `'6h'` or `'1d'`                        |
| `expect`             | Omitted  | Domain-defined acceptance criteria                                                  |
| `currency`, `locale` | Omitted  | Site metadata, for example `'AUD'` and `'en-AU'`                                    |

Defaults above are the fresh database and registration defaults. Registration
updates supplied settings; some omitted settings retain their existing database
values, so explicitly set a value when changing an existing site's behavior.
`scope`, `expect`, `refresh`, proxy settings, `currency` and `locale` are cleared
when omitted; snapshot mode, timeout and path rules receive their defaults.

Once registered, the site's database row controls `threadCount`. Editing the
module and registering again does not overwrite it. Use
`PATCH /api/sites/<id>` with `{"threadCount": 2}` to change it (the API accepts
1–8). A running crawl is restarted when possible to apply that change.

## Path rules and robots.txt

Rules start with `/`, support `*` and a trailing `$`, and use the longest matching
rule. For example:

```ts
export const site = {
  allow: ['/docs/'],
  disallow: ['/', '/docs/private/'],
};
```

The broad disallow excludes other paths; the more specific allow admits `/docs/`.
The still more specific disallow excludes its private subsection. An `allow`
list by itself does not exclude everything else.

Crawler path rules apply to domain page types; the seed and images are exempt.
The remote host's robots.txt policy is checked separately for requests, including
seed and handler fetches. A robots.txt 4xx permits fetching; a 5xx or network
failure prevents fetching from that host until the policy can be read again.
Its `Crawl-delay` is combined with your pacing by using the longer delay.

Pacing is shared across the crawl's threads. Increasing concurrency does not
remove the interval between request starts.

## Proxies

`site.proxy` selects a route from a deployment's proxy provider. Proxying needs
the provider service and its configuration; an arbitrary proxy URL is not a
`site.proxy.type`. Direct fetching needs no proxy provider.

The engine shares the site's proxy among its fetch loops and can renew routes
or replace a failed proxy during retries. The default provider adapter and its
contract are in [proxy.ts](../src/core/proxy.ts). Use `/api/proxies` to inspect
provider state; see [HTTP API](http-api.md).
