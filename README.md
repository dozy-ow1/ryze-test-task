# Ryze publishing pipeline

Generate an article and cover image, then publish them to WordPress.
Postgres holds the work queue and progress; separate worker pools generate and publish content.

## Try it

Requires **Node 22+**, **pnpm 10**, and **Docker Compose v2**.

```sh
corepack enable
pnpm install
pnpm demo
```

The demo publishes 300 articles through fault-injected mock services and kills workers twice.
It uses temporary containers, image tags, storage and ports, forces mock credentials, and cleans
up afterward. Your `.env` and persistent development stack are left alone.

## Develop locally

```sh
cp .env.example .env             # first setup only
# Set POSTGRES_PORT=5433 in .env if 5432 is occupied.
docker compose up -d --build --wait
pnpm seed
```

Services bind to localhost: API **8080**, mock providers **8091**, mock platforms **8092**,
MinIO **9000**. Configuration comes from `.env`; recreate services after changing it.
Worker limits are in [`settings.ts`](packages/worker/src/settings.ts). `LLM_PROVIDER` and
`IMAGE_PROVIDER` select `mock` or a real provider once during client creation; individual
provider methods do not branch on environment variables.

| Command | Purpose |
| --- | --- |
| `pnpm test` | Unit and database tests; needs local Postgres |
| `pnpm typecheck` | Clean build and TypeScript checks |
| `pnpm lint` | Formatting, single-line imports, spacing and lint checks |
| `pnpm format` | Apply those formatting conventions |
| `E2E=1 pnpm test` | Also run the isolated 50-article demo without kills |
| `pnpm smoke` | Publish to configured **real accounts**, incurring provider charges |

Tests are colocated as `*.spec.ts`. Shared database fixtures live in `core/testing`; mock helpers
live beside the mock service. Neither is included in production builds. Database tests use
disposable schemas.

## Code map

- **`packages/api`** — Fastify route plugins, with handlers, schemas and constants grouped by feature;
  shared validation and errors live in `src/utils`.
- **`packages/worker`** — generation, publishing, lease management and reconciliation.
- **`packages/core`** — database queries, quotas, provider clients and platform adapters.
- **`packages/mock-providers`** — HTTP mocks for text and image generation.
- **`packages/mock-wordpress`** — WordPress HTTP mock with posts, media and fault injection.
- **`db/migrations`** — ordered, checksummed SQL migrations.
- **`Dockerfile`** — shared build recipe; Compose selects each workspace package with `PKG`.

The API and workers coordinate through database rows.

## API

| Endpoint | Purpose |
| --- | --- |
| `POST /sites` | Register `{platform, base_url, token}` |
| `PATCH /sites/:id` | Replace `{token}` and reactivate the site |
| `POST /articles` | Submit `{site_id, brief, idempotency_key}` |
| `POST /articles/bulk` | Submit `{items: [...]}`, up to 1,000 articles |
| `GET /articles/:id` | Read progress and recorded usage |
| `GET /articles/summary` | Read pipeline totals |
| `POST /articles/:id/retry` | Retry a failed or unknown operation |
| `GET /healthz`, `GET /readyz` | Process and database health |

Repeating an article's idempotency key returns its original ID. After replacing site credentials,
retry failed articles separately. Tokens are encrypted with `SITE_TOKEN_KEY`.

## Before using real accounts

Set provider keys and site details using the examples in [`.env.example`](.env.example).
WordPress needs its REST root and an application password. These integrations have offline coverage; live accounts have not been validated.

The API has **no authentication**. Keep it local or put access control in front of it.
A lost response or crash can repeat a paid generation call. Platform lookups and lease fencing
reduce duplicate writes; they do not provide unconditional exactly-once delivery.
Reconciliation removes stray drafts on the mocks; real-platform enumeration is not implemented.

## Existing databases

Applied migrations are immutable. Add a numbered SQL file for schema changes. Before rebuilding
an older local stack, run `docker compose down --remove-orphans` to stop renamed services
while keeping their volumes.
An older, unversioned database needs a backup and schema review against
[`001-initial.sql`](db/migrations/001-initial.sql), then `pnpm migrate --baseline` with
`DATABASE_URL` pointing at that database. New databases migrate automatically through Compose.
