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

## Notes on inputs

- `db/schema.sql` and `db/schema_test.sql` were not part of the build spec I received, so they were
  written from its description (tables, columns, the CLAIM / RENEW / COMPLETE / RETRY / DEFER / FAIL /
  QUOTA / BREAKER statements). The statements in `packages/core/src/db.ts` are checked against both
  files by `packages/core/test/statements.test.ts`.
- The official `minio/minio` and `minio/mc` images are no longer pullable, so Compose uses the
  Bitnami builds of the same binaries (`bitnamilegacy/minio`, `bitnamilegacy/minio-client`).
