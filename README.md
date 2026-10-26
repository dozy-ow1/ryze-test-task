# Ryze publishing pipeline

Generate an article and cover image, then publish them to Shopify.
Postgres is the queue and progress ledger; background workers generate and publish content.

## Run

Requires **Node 22+**, **pnpm 10**, and **Docker Compose v2**.

```sh
corepack enable
pnpm install
pnpm demo
```

The demo publishes 300 articles through fault-injected mocks and kills workers twice.
It creates temporary images, containers, storage and ports, then cleans up. It does not use
real provider keys or change your persistent stack.

For persistent local development:

```sh
cp .env.example .env                 # first setup only
# For pnpm seed, use SHOPIFY_MODE=mock, LLM_PROVIDER=mock and IMAGE_PROVIDER=mock.
# Set POSTGRES_PORT=5433 in .env if 5432 is occupied.
docker compose up -d --build --wait
pnpm seed
```

Ports bind to localhost: API **8080**, mock providers **8091**, mock Shopify **8092**, MinIO **9000**.

## Layout

| Location | Responsibility |
| --- | --- |
| `apps/api` | HTTP intake; each feature owns its routes, handlers and schemas |
| `apps/worker` | Background service: pipeline modules, runtime lifecycle and external clients |
| `apps/mock-providers` | Text/image API simulation for local development |
| `apps/mock-shopify` | Shopify API simulation with fault injection |
| `packages/shared` | Shared database, provider, platform and utility code |
| `packages/shared/src/database/migrations` | Ordered, checksummed SQL migrations |
| `tools/development` | Demo, seed data and real-account smoke commands |
| `tools/formatting` | Formatting conventions layered over Biome |

Runnable services live in `apps`; reusable code lives in `packages`. Each service starts in
`src/main.ts`. Features live under `src/modules`; worker queue/lease mechanics live under
`src/runtime`, and its reconciliation command has a separate entrypoint.
Tests sit beside their modules as `*.spec.ts`. Shared test helpers live in `src/testing`, excluded
from production builds. The shared package keeps SQL beside its database code and copies it to
`dist` during the build; its migration command runs the compiled entrypoint directly.

## Commands and configuration

| Command | Purpose |
| --- | --- |
| `pnpm test` | Unit/database tests; needs local Postgres and uses disposable schemas |
| `pnpm typecheck` | Clean builds and TypeScript checks |
| `pnpm lint` / `pnpm format` | Check/apply formatting and lint rules |
| `pnpm migrate` | Apply shared SQL migrations to `DATABASE_URL` |
| `pnpm seed` | Register mock sites and submit sample articles |
| `pnpm demo` | Isolated acceptance run; `E2E=1 pnpm test` adds a smaller run without kills |
| `pnpm smoke` | Publish to configured **real accounts**, incurring provider charges |

`biome.json` defines formatting and lint rules, including indentation, quotes and required braces.
The formatting tool preserves single-line imports and separates logical blocks; it runs Biome once.
Application settings come from `.env` and are validated at startup. Recreate workers after changing
provider settings. Provider selection happens once
in the client factory. Worker limits live in [`settings.ts`](apps/worker/src/settings.ts).
The root `Dockerfile` builds each service selected by Compose's `PKG` argument.

## API and operating limits

Register a site with `POST /sites {platform, base_url, token}` and submit work with
`POST /articles {site_id, brief, idempotency_key}` or `POST /articles/bulk {items}` (up to 1,000).
Briefs are limited to 10,000 characters; upstream responses to 32 MiB.
Read progress at `GET /articles/:id` or `/articles/summary`. Repeated keys return the original ID.
`PATCH /sites/:id {token}` replaces credentials; `POST /articles/:id/retry` retries a failed operation.
`/healthz` checks the API process; `/readyz` checks its database connection.

The API has no authentication: keep it local or put access control in front of it. A crash or lost
response can repeat paid generation. Platform lookups and lease fencing reduce duplicate writes;
they do not provide unconditional exactly-once delivery. Basic Shopify publication has been exercised against a real store. Stray-draft enumeration
currently runs only against the mock; production load capacity has not been validated.

Applied migrations are immutable. For an older unversioned database, back up and review its schema
against [`001-initial.sql`](packages/shared/src/database/migrations/001-initial.sql), then run `pnpm migrate --baseline`
with `DATABASE_URL` pointing at that database. Before rebuilding an older local stack, use
`docker compose down --remove-orphans` to stop renamed services while keeping their volumes.

## Shopify

Install an app on your store with `write_content`, `read_files` and `write_files`.
For the supported client credentials flow, the app and store must belong to the same Shopify
organization. Keep the storefront password enabled while testing; Admin API access is separate.
Set `SHOPIFY_SHOP` (the `store.myshopify.com` hostname), `SHOPIFY_CLIENT_ID` and
`SHOPIFY_CLIENT_SECRET` in `.env`, then run `pnpm shopify:check`. It only checks access and lists
blogs. Set `SHOPIFY_BLOG_ID` to the chosen `gid://shopify/Blog/...` value.

`pnpm smoke` **publishes one article** to the configured Shopify blog; it supports mock
images with real text. The generated cover is uploaded directly to Shopify, so S3 need not be public.
API registration uses `platform: "shopify"`, `base_url: "https://store.myshopify.com"` and a `token`
string containing JSON `{clientId, clientSecret, blogId}`; credentials are encrypted at rest.
Tokens renew automatically. The adapter uses Admin GraphQL API `2026-07` and checks remote article
ownership before adopting retries. `SHOPIFY_MODE=mock` redirects the same adapter to `mock-shopify`
for local seed/demo runs; the default `live` mode uses the real store.
