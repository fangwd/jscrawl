# Proxy provider API

A crawler whose `site` names a proxy fetches through proxies from the
deployment's proxy provider: any service that implements the HTTP API below.
jscrawl finds it through two settings:

```sh
PROXY_PROVIDER_URL=http://127.0.0.1:8080
PROXY_PROVIDER_TOKEN=<the provider's bearer token>
```

Without them a site that asks for a proxy fails to crawl; it is never fetched
directly instead.

```ts
export const site: SiteConfig = { waitTime: 3, proxy: { type: 'residential', country: 'AU' } };
```

`type` is a name the provider defines (lower-case letters, digits and dashes);
jscrawl passes it on without interpreting it. `country` is ISO 3166-1 alpha-2;
omitted, any country will do.

## Requests

Every request carries `Authorization: Bearer <PROXY_PROVIDER_TOKEN>`. Bodies are
JSON. An error is any status of 300 or above, with `{"error": "<message>"}`.

### `POST /proxies`

```json
{ "type": "residential", "country": "AU", "owner": "jscrawl:run:42" }
```

Creates a proxy and answers `201` with it once it is usable - the next request
through it must work, however long getting there takes (jscrawl waits up to five
minutes). `country` may be null. A type or country the provider does not offer
is an error (`400`).

`owner` is opaque to the provider; it is stored and listed so jscrawl can find
proxies a dead process left behind.

### `GET /proxies`

Every proxy the provider holds, as an array.

### `POST /proxies/{id}/renew`

A new route out for the same proxy - a new exit IP, in the same country. Answers
with the proxy once requests through it take the new route; a provider that can
only renew so often waits rather than answering early. `url` may change.

### `DELETE /proxies/{id}`

Removes the proxy. `404` when there is no such proxy.

## A proxy

```json
{ "id": 3, "url": "socks5h://127.0.0.1:43017", "type": "residential", "country": "AU", "owner": "jscrawl:run:42" }
```

- `id`: a string or a number, unique among the provider's proxies.
- `url`: where to send requests - `socks5h://` (host names resolved by the
  proxy), `socks5://`, `socks4a://` or `http://`, credentials in the URL. It
  must be reachable from the machine the crawls run on. When nothing answers
  there any more, jscrawl removes the proxy and creates another.
- `type`, `country`, `owner`: as created.

## What jscrawl does with them

- A crawl process creates a proxy with its first request and deletes it when it
  ends. The supervisor deletes those of crawls that were killed: their owner is
  `jscrawl:run:<id>` (`jscrawl:pid:<pid>` for a CLI run).
- The agent's tool server shares one proxy per type and country (owner
  `jscrawl:tools`) and deletes it after 15 idle minutes.
- A request that fails through a proxy - a network error, or 403, 429 or 503,
  which an exit IP draws - is retried after a renewal, up to the site's
  `maxRetryCount`; only then does it count towards the crawl's blocked rule.
