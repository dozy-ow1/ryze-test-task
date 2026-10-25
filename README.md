# Ryze publishing pipeline (minimal version)

Generates SEO articles and publishes them to customers' sites: text (LLM) → cover image (image
model) → upload to the customer's platform → publish. Postgres is the only source of truth; workers
can be killed at any moment and every article still ends up live exactly once, with its image, without
paying twice for text or images already generated.

> Work in progress: this README grows with each milestone.

## Quick start

```sh
cp .env.example .env          # set POSTGRES_PORT=5433 if 5432 is taken on your machine
pnpm install
docker compose up -d --wait postgres minio
docker compose up migrate minio-init   # applies db/schema.sql, creates the bucket
pnpm test
```

Check the SQL contract against the Compose database (30 assertions, rolled back afterwards):

```sh
docker compose exec postgres psql -U ryze -d ryze -v ON_ERROR_STOP=1 -f /db/schema_test.sql
```

## Intake API (port 8080)

Stateless Fastify process: it writes rows and never calls a provider or a platform. No
authentication in this version.

| Route | Result |
| --- | --- |
| `POST /sites {platform, base_url, token}` | 201 `{id}`; token stored AES-256-GCM encrypted; creates the site's quota row |
| `POST /articles {site_id, brief, idempotency_key}` | 202 `{article_id}` when new, 200 with the same id when the key repeats |
| `POST /articles/bulk {items}` (≤ 1000) | 202 `{results: [{article_id, created}]}`, one transaction, three statements in total |
| `GET /articles/:id` | the article and its operations |
| `GET /articles/summary` | operation counts by step and status, articles total and published |
| `POST /articles/:id/retry` | 202 if the latest operation is `failed` or `unknown`, else 409 |
| `GET /healthz`, `GET /readyz` | liveness; readiness runs `SELECT 1` (503 when the database is down) |

Errors: 400 validation, 404 unknown site or article, 409 inactive site or retry not allowed,
503 database unavailable (requests are transactional, so a failure never leaves partial rows).

## Notes on inputs

- `db/schema.sql` and `db/schema_test.sql` were not part of the build spec I received, so they were
  written from its description (tables, columns, the CLAIM / RENEW / COMPLETE / RETRY / DEFER / FAIL /
  QUOTA / BREAKER statements). The statements in `packages/core/src/db.ts` are checked against both
  files by `packages/core/test/statements.test.ts`.
- The official `minio/minio` and `minio/mc` images are no longer pullable, so Compose uses the
  Bitnami builds of the same binaries (`bitnamilegacy/minio`, `bitnamilegacy/minio-client`).
