# jscrawl documentation

[Project README](../README.md)

jscrawl is a crawl engine embedded in a TypeScript application. There are three
parts to a deployment:

1. **The engine** owns the URL queue, fetching, saved responses, runs and issues.
2. **A domain** defines record tables, write methods, page types, validation and
   the records exposed through HTTP and MCP.
3. **Site crawlers** know where to find those records on particular websites.

Register one domain per process with `useDomain()` before using the engine. The
same domain must be registered by the CLI, HTTP server and MCP server processes.

## Choose a starting point

| I want to…                                       | Read                                            |
| ------------------------------------------------ | ----------------------------------------------- |
| Create an app and crawl my first site            | [Getting started](getting-started.md)           |
| Define the records my app collects               | [Domains and records](domains.md)               |
| Add a website to an existing app                 | [Writing site crawlers](crawlers.md)            |
| Configure connections, storage or crawl behavior | [Configuration](configuration.md)               |
| Run commands from a terminal                     | [CLI reference](cli.md)                         |
| Integrate a dashboard or script                  | [HTTP API](http-api.md)                         |
| Connect an agent and use its tools               | [MCP tools](mcp.md)                             |
| Schedule crawls or investigate a failure         | [Operations and troubleshooting](operations.md) |
| Contribute to the engine                         | [Development](development.md)                   |

## How a crawl works

Registering a site creates its database rows and queues its exported `SEED_URL`.
A crawl claims idle URLs, fetches each page and dispatches it to a handler named
after its type: `seed` goes to `scrapeSeed`, `page` to `scrapePage`, and so on.
Handlers buffer extracted records and queue discovered links. The engine flushes
each page's records, validates the saved result and continues through the queue.

The standard crawl fetches `seed` and domain page types. `image` is a core URL
type that can be recorded in the queue, but is excluded from that crawl loop.

An empty queue ends the crawl. A subsequent crawl processes newly idle URLs;
resetting URLs requests another pass over pages already processed. Completed
passes record domain metrics and check expectations and regressions.

The guides use the example app's npm scripts. These scripts are created in
[Getting started](getting-started.md); they are not scripts in the engine repo.
