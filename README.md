# Install Docker

```
brew install docker docker-compose colima
colima start

docker-compose up -d
docker-compose down # when necessasry
```

# Prepare crawler database

`docker-compose up -d` starts Postgres in the `jscrawl-postgres` container on
port 5434 (user `admin`, password `secret`, database `jscrawl`). Load the schema:

```
docker exec -i jscrawl-postgres psql -U admin -d jscrawl -v ON_ERROR_STOP=1 < etc/schema.sql
```

To open a SQL shell:
```
docker exec -it jscrawl-postgres psql -U admin jscrawl
```

To inspect where Docker keeps the volume for Postgres:
```
docker volume ls
docker volume inspect jscrawl_pgdata
```

(By default, Docker Compose uses the directory name (or a project name defined by -p flag) 
as a prefix for named volumes. As the current directory is named jscrawl, Docker Compose will
automatically create volumes prefixed with jscrawl_.)

After pulling changes, upgrade an existing domain database with `npm run
db:migrate`. It uses `DATABASE_URL` from the environment or `.env`, falling back
to `etc/config.json`. The server also runs these additive migrations before
starting, including when launched directly with `npm run serve`. Existing
crawl data is retained. The migrations add the response storage policy,
`crawler.refresh_minutes`, `site.expect` and the `crawl_snapshot` table; existing
sites keep manual scheduling and no expectations until configured. They also
update the run-status constraint to accept the new `blocked` outcome, and add
`product_variant.sort_order`, the site's order of a product's variants, which
the feed follows (existing variants keep id order until scraped again).

# Site crawlers

The crawlers are not part of this repository. `crawlers/` is a **separate git
repository** that jscrawl ignores: one TypeScript module per site, written by the
agents and reviewed by humans, and dropped and regenerated wholesale often enough
that their history should not sit in the core's.

```
git clone <crawlers repo> crawlers     # next to src/, inside this checkout
```

The directory must stay inside a jscrawl checkout - crawler modules import
`../src/core/...`, and Node resolves a module's imports from its real path, so a
symlink from elsewhere does not work. The core resolves a site name to
`crawlers/<name>.ts` (`src/core/sites.ts`); point it somewhere else with
`sites.dir` in `etc/config.json` or `JSCRAWL_SITES_DIR` (which is how the tests
use a fixture directory). Commit crawler changes with `git -C crawlers ...`.
`npm run build` typechecks the crawlers together with the core, and
`bin/start.sh` reports how many it found.

# Development

## The agent

The agent that builds and fixes crawlers, and triages the issues crawls raise,
is [spidermake](../spidermake): its own server (`:3121`), with mason embedded,
its manifest, skills and prompts, the triage budgets - and the dashboard, where
people sign in. It depends on jscrawl through four things, and jscrawl knows
nothing of it:

- the agent's tools at `/mcp` (below), which it mounts as `jscrawl_*`;
- `GET /api/problems`: the open problems to investigate, one per site, page type
  and issue kind, each represented by its earliest open issue;
- the rest of the API, which the dashboard shows and drives;
- jscrawl's checkout, where the agent works: it writes crawlers and their test
  pages under `crawlers/`.

Issues of one site, page type and kind are one problem, however their details
read: the agent investigates the first, its verdict (`jscrawl_resolveIssue`)
settles the others, and later ones take it at once while it awaits review
(`src/core/issues.ts`).

The tool server's SQL accepts one SELECT/WITH query and returns at most 200
rows. SQL and issue resolution statements time out after 30 seconds. Remaining
deployment constraints: `jscrawl_webfetch` allows private-network URLs, file
reads are not confined to the repository, and SELECT functions have the
configured database user's privileges. Use network/filesystem isolation and a
restricted database role when running investigations on untrusted content.

## API access

jscrawl is one address, `127.0.0.1:3120` by default (`JSCRAWL_HOST`,
`JSCRAWL_PORT`): the API under `/api/`, the agent's tools at `/mcp`, and
`GET /healthz`, which answers 200 once the tools are up (503 until then). Every
route but `/healthz` needs the service token `JSCRAWL_API_TOKEN` as a bearer:
put it in `.env` (`openssl rand -hex 32`, 16+ characters); the server won't
start without it. spidermake holds the same token; only it and scripts call
jscrawl, so keep the address private.

## Product images

`product_image.pure` says whether an image shows the product alone (a tile's
face filling the frame, a sofa on a plain backdrop) rather than a room scene,
props or a graphic; null when the crawler cannot tell. Each crawler sets it from
a rule over the page - a url token, alt text, a gallery role - so crawling calls
no classifier. The agent learns that rule with `jscrawl_classifyImages` and
checks it with `jscrawl_imageAudit` (precision and recall against the
classifier on a sample of saved products); see step 4c of the new-site skill.
Both call imaged's `product_images` job (`IMAGED_URL`, default
`http://127.0.0.1:8800`, read by the tool server), which
uses Claude Haiku and falls back to a local CLIP + OpenCV model without an API
key.

## Running

One command brings up Postgres (docker-compose), loads the schema into a
brand-new database only (an existing database is never reloaded), and starts
jscrawl on `3120`. spidermake, with the dashboard, is started on its own:

```
npm run jscrawl:start        # Postgres + jscrawl on http://127.0.0.1:3120
npm run serve                # the server alone (:3120)
npm run mcp                  # the tool server alone, on a free port it prints
npm run reset                # wipe the stores (asks first; bin/reset.sh --help)
```

The feed format reference is served at `/api/docs/feed-format`, for the
dashboard. Executable scripts live in `bin/` (`start.sh`, `reset.sh`); `etc/`
holds configuration only (`config.json`, `schema.sql` and the migrations).

## Resetting

`bin/reset.sh` clears the stores, which live in three places:

```
npm run reset                # domain DB + snapshots + logs
bin/reset.sh --db            # Postgres only (reloads etc/schema.sql)
bin/reset.sh --snapshots     # data/html + data/images (14 GB of saved pages here)
bin/reset.sh --logs          # data/logs
npm run reset:test           # reload the schema into jscrawl_test
bin/reset.sh --e2e           # and into the e2e database
bin/reset.sh --all --keep-snapshots
```

It prints what it will delete (with sizes) and asks first; `--yes` skips the
prompt. `data/html` is deleted with the domain database by design: snapshots are named
`<url_id>.<version>`, so keeping one side of that pair leaves orphans or
dangling references.

Never touched: `crawlers/` (its own repository, with each crawler's test pages
in `crawlers/fixtures/<site>/`), `.env`, `build/`. After a `--db` reset the database is empty, so
register every crawler with `npm run jscrawl:populate`.

Crawls are started per site from the dashboard or the chat, not by these
scripts. (The start script wraps `docker-compose up`, the schema
load/migration and `npm run serve`. Run those manually if you prefer.)

Crawler processes are supervised by the server: the API (a site page's Crawls
card in the dashboard) starts/stops/restarts `--crawl` children (at most one per site), tails their
logs under `data/logs/` and records every run in `crawler_run`. Stops are
graceful - the crawler finishes its current url on SIGTERM - with a SIGKILL
after 10 s; orphaned runs from a dead server are reconciled on startup.
`Re-scrape now` runs a one-shot `--scrape-url` child and is refused while the
site's crawl runs; `Re-scrape (queue)` idles the url for the next crawl.

The agent's domain tools are served at `/mcp` (MCP over streamable HTTP) by
jscrawl's tool server, `src/mcp/server.ts`: a child of the jscrawl server
(restarted if it exits) on a free loopback port, which the server forwards
`/mcp` to. It is its own process because it runs agent-written crawler code and
long typechecks, which must not stall the API or the running crawls. It is
stateless and shared by every agent session. spidermake mounts it as its
`jscrawl` server - hence the `jscrawl_` prefix on every name. The chat agent (build profile) can drive the same supervisor through
tools: `jscrawl_crawlStatus`, `jscrawl_crawlStart`, `jscrawl_crawlStop`,
`jscrawl_crawlRestart`, `jscrawl_requeueUrl` and `jscrawl_crawlLog`. The
unattended triage and read-only explore profiles do not get them.

spidermake's build profile holds the agent to the new-site skill rather than
asking it to:

- its shell runs only `git -C crawlers` status and diff, and it writes files
  only under `crawlers/` (a site's pages under `crawlers/fixtures/<site>/`);
- every edit of `crawlers/<site>.ts` runs `jscrawl_checkCrawler` - a typecheck,
  the skill's rules (`src/core/lint.ts`: no page caps, no `this.client`, no
  flush, no slug lists, no /tmp files) and a dry run of the test pages listed in
  `crawlers/fixtures/<site>/pages.json` - and appends the result to the edit; a
  run that edited a crawler cannot finish until that check passes (mason gives
  it three repairs, then fails the run);
- it finishes with `jscrawl_submitCrawler`, which commits the crawler and its
  test pages (the listed ones and what their handlers fetched) to the
  `crawler/<site>` branch on top of the crawlers repository's `main` - in a
  scratch index, so the checkout other sessions edit is untouched - pushes it and
  opens or updates its pull request with `gh`.

The jscrawl server fast-forwards `crawlers/` to `origin/main` every 5 minutes, so
a merged crawler reaches the crawls (and the scheduled re-crawls that run right
after). A file main changes that is edited here holds the sync back - it is
logged - unless it already matches main, as an agent's own submitted work does
once merged. Prod needs the crawlers repository cloned with an `origin` it can
push to, and `gh` authenticated (`gh auth login`, or `GH_TOKEN`).

Every product fixture needs a `sections` inventory with source evidence and
assertions against saved fields. Missing values, unsupported sections and
uncovered standard tab panels fail the completion gate, even when scraping
succeeds. Existing manifests must add these contracts before crawler edits can
pass. See [the contract format](../spidermake/skills/new-site/completeness.md).

`jscrawl_validateCrawler` is the same check for any list of pages, returning the
records. `jscrawl_scrapeUrl` then scrapes a few live pages with the registered
crawler and shows what was saved. Restart the jscrawl server after changing a
tool's implementation or schema; agent sessions see the new listing on their
next run.

# To crawl a site

In a crawler's exported `site` config, `pageSnapshots: 'gzip'` (the default)
compresses saved HTML/JSON responses. Use `'off'` to skip saving page bodies,
or `'raw'` for uncompressed snapshots. Fetch history and extracted data are
still saved; every crawl fetches fresh content. Run `npm run jscrawl:populate`
after changing the setting and restart an active crawl. The site UI and
`jscrawl_inspectUrl` show the registered policy.

Every request a crawl makes obeys its host's robots.txt (RFC 9309): a page it
disallows is recorded as disallowed (status 3) and never fetched, a handler fetch
it disallows fails the scrape, a missing robots.txt (4xx) allows everything, and
one the host cannot serve (5xx, no answer) stops requests to that host until it
can, read again a minute later. A reset of all urls re-checks disallowed ones.

A crawler states what the request it was built for promises in `site.expect` -
a product count range and the fields every product carries (`price`,
`availability`, `image`, `category`, `description`, `brand`). Its product test
pages must carry those fields (`jscrawl_checkCrawler`), and after each complete
crawl - one that ran out of urls, not one stopped part way - the crawler compares
the whole catalogue: a count outside the range, or a field on fewer than 95% of
products, raises an `acceptance` issue for the triage agent, filed against the
site's seed url (`jscrawl_checkExpectations` shows the numbers).

Each complete crawl also records the site's state - active products, how many
carry each field, and product pages scraped and failed (`crawl_snapshot`) - and
compares it with the last complete crawl's. A product count down 20%, failing
product pages up 10 points, or a field's share down 10 points (on sites of at
least 10 products) raises a `regression` issue: the catalogue alone would hide a
broken crawl, since a page that starts failing keeps its earlier products
(`jscrawl_crawlHistory` lists the snapshots).

A crawl whose page fetches fail 20 in a row - any error or HTTP status but 404
and 410 - stops itself rather than fail every url left, raises one `blocked`
issue on the seed url, and its run is recorded as `blocked`. Restart stopped
crawls retries it, as does the next scheduled refresh.

A crawler that sets `site.refresh` (`'6h'`, `'1d'`, `'7d'`) is re-crawled by the
jscrawl server: every 5 minutes it resets and restarts each site whose interval
has passed since its last crawl started. A site never crawled is left alone - its
first crawl is started by hand - and one still crawling waits for its run to end.

What a scrape handler fetches besides its page (`this.fetch`: an API, a sitemap)
goes out at the same pace as the pages - the site's `waitTime`, or robots.txt's
`Crawl-delay` when longer, counted from the previous request - and is saved
beside the page's snapshot in `<id>.<version>.fetches/`. Re-scraping the
snapshot (`jscrawl_scrapePreview`, triage) replays those responses instead of
asking the live site. A fixture works the same way: its first preview or check
records what the handler fetches in `<file>.fetches/`, later ones replay it, and
saving the fixture again through `saveTo` drops the recordings.

Existing snapshots stay readable and are not converted or deleted. The web UI,
CLI and agent HTML/preview tools read gzip snapshots directly. With storage off,
verification uses live pages or explicit fixtures instead of historical bodies.
Startup applies `etc/migrate-page-snapshots.sql`,
`etc/migrate-crawl-settings.sql` and `etc/migrate-variant-order.sql` to
existing databases. Run `npm run db:migrate`
before using the CLI directly after an upgrade.

```
# Prepare the database
$ docker exec -i jscrawl-postgres psql -U admin -d jscrawl -v ON_ERROR_STOP=1 < etc/schema.sql

# Start crawling
$ npm run jscrawl -- --crawl amber-tiles
```

# Install asdf and nodejs
Instructions: https://asdf-vm.com/guide/getting-started.html
```
brew install asdf
# Add this to ~/.zshrc (important)
# export PATH="${ASDF_DATA_DIR:-$HOME/.asdf}/shims:$PATH"
brew install gpg gawk
asdf plugin add nodejs https://github.com/asdf-vm/asdf-nodejs.git
asdf install nodejs 24.21.0
asdf set -u nodejs 24.21.0
```

# Deploying on Ubuntu

A deployment is four things on one box, of which only nginx is public:

- Postgres - the crawl data;
- jscrawl - this repository on `127.0.0.1:3120`: the API under `/api`, the
  agent's tools at `/mcp`, and the crawls, which it runs as child processes;
- [spidermake](https://github.com/fangwd/spidermake) on `127.0.0.1:3121`: the
  dashboard, sign-in and the agent;
- nginx - https in front of spidermake.

Ubuntu 24.04 LTS, arm64 or x86-64. A t4g.large (2 vCPU, 8 GB) with a 60 GB disk
is enough to start; saved pages (`data/html`) grow with every crawl. Open only
22, 80 and 443.

## 1. Packages

```sh
sudo apt update
sudo apt install -y git build-essential pkg-config postgresql nginx chromium-browser gh

# Node 24 (x64 instead of arm64 on Intel/AMD)
curl -O https://nodejs.org/dist/v24.21.0/node-v24.21.0-linux-arm64.tar.xz
sudo tar -xJf node-v24.21.0-linux-arm64.tar.xz -C /usr/local --strip-components=1

# Rust 1.94 or newer, for spidermake
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
. ~/.cargo/env
```

Chromium is the browser puppeteer drives for crawlers that need one, and for
the agent's page probes.

## 2. Access

The box needs an SSH key that GitHub accepts for `fangwd/jscrawl`,
`fangwd/spidermake` and `fangwd/mason` (spidermake builds it as a git
dependency), and that can push to the crawlers repository: the agent submits
each crawler as a branch and pull request. Sign `gh` in for the pull requests:

```sh
gh auth login
```

## 3. Database

```sh
sudo -u postgres psql -c "create user jscrawl with password '<password>'"
sudo -u postgres createdb -O jscrawl jscrawl
```

## 4. jscrawl

```sh
mkdir -p ~/apps && cd ~/apps
git clone git@github.com:fangwd/jscrawl.git && cd jscrawl
git clone <crawlers repository> crawlers
PUPPETEER_SKIP_DOWNLOAD=true npm ci
```

`~/apps/jscrawl/.env` (`DATABASE_URL` wins over `etc/config.json`, which is
the docker setup for development):

```sh
DATABASE_URL=postgresql://jscrawl:<password>@127.0.0.1:5432/jscrawl
JSCRAWL_API_TOKEN=<openssl rand -hex 32>
PUPPETEER_EXECUTABLE=/usr/bin/chromium-browser
# IMAGED_URL=http://127.0.0.1:8800     # imaged, for the agent's image tools (optional)
```

Load the schema and register the crawlers:

```sh
set -a && . ./.env && set +a
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 < etc/schema.sql
npm run jscrawl:populate
```

## 5. spidermake

```sh
cd ~/apps
git clone git@github.com:fangwd/spidermake.git && cd spidermake
cp .env.example .env
npm --prefix ui ci && npm --prefix ui run build
cargo build --release
```

In `~/apps/spidermake/.env`: the `AI_*` model settings and `JSCRAWL_API_TOKEN` -
the same value as jscrawl's.
spidermake finds jscrawl's checkout at `../jscrawl` and its server at
`http://127.0.0.1:3120`. Add the people who sign in:

```sh
target/release/spidermake add-user you@example.com     # asks for a password
```

## 6. Services

`/etc/systemd/system/jscrawl.service`:

```ini
[Unit]
Description=jscrawl (API, agent tools and crawls on 127.0.0.1:3120)
After=postgresql.service

[Service]
User=ubuntu
WorkingDirectory=/home/ubuntu/apps/jscrawl
ExecStart=/usr/local/bin/node -r ts-node/register src/server.ts
Restart=on-failure
TimeoutStopSec=30

[Install]
WantedBy=multi-user.target
```

`/etc/systemd/system/spidermake.service`:

```ini
[Unit]
Description=spidermake (dashboard and agent on 127.0.0.1:3121)
After=jscrawl.service
Wants=jscrawl.service

[Service]
User=ubuntu
WorkingDirectory=/home/ubuntu/apps/spidermake
ExecStart=/home/ubuntu/apps/spidermake/target/release/spidermake
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now jscrawl spidermake
curl -s http://127.0.0.1:3120/healthz      # {"status":"ok",...} once the agent's tools are up
curl -s http://127.0.0.1:3121/healthz
journalctl -u jscrawl -f                   # or -u spidermake
```

Both read their `.env` from their working directory. spidermake waits for
jscrawl's `/healthz` before it starts. Stopping jscrawl stops its crawls
gracefully; they are recorded as stopped, and "Restart stopped crawls" on the
dashboard resumes them where they left off.

## 7. nginx

`/etc/nginx/sites-available/crawl`, linked into `sites-enabled`:

```nginx
server {
    listen 80;
    server_name crawl.example.com;

    location / {
        proxy_pass http://127.0.0.1:3121;
        # spidermake refuses a browser's writes whose Origin is not this host
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        # the chat streams live events
        proxy_buffering off;
        proxy_read_timeout 1h;
    }
}
```

```sh
sudo nginx -t && sudo systemctl reload nginx
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d crawl.example.com
```

Sign in at https://crawl.example.com; crawls are started from the Sites tab
or by asking the agent.

## Updating

```sh
cd ~/apps/jscrawl && git pull && PUPPETEER_SKIP_DOWNLOAD=true npm ci && sudo systemctl restart jscrawl
cd ~/apps/spidermake && git pull && npm --prefix ui ci && npm --prefix ui run build \
  && cargo build --release && sudo systemctl restart spidermake
```

jscrawl applies its database migrations when it starts. Restarting it stops the
running crawls; resume them from the dashboard.

## Backups

The Postgres database (`pg_dump -Fc`), jscrawl's `data/` (saved pages and
images) and spidermake's `data/` (users, triage state and the agent's
conversations). The crawlers live in their own repository.
