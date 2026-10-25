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

## Worker

One binary, `packages/worker`: `--pool=generate` runs verify, text, image_submit, image_fetch;
`--pool=publish` runs upload, draft, publish; `--mode=reconcile` runs the reconciler once.

- **Claim**: `free = CONCURRENCY - in flight`; one `CLAIM` statement (`FOR UPDATE SKIP LOCKED`) takes
  up to `free` due rows of the pool's steps, or rows whose lease expired, and gives each a new
  `lease_version`. Sleep 250-500 ms, repeat; no LISTEN/NOTIFY.
- **Lease**: while a step runs, `RENEW` every `LEASE_SECONDS / 3`; zero rows means another worker
  owns the row now, so the step is aborted.
- **Complete**: one transaction writes `succeeded` + usage, the step's own article columns and the
  next step's row. Every write carries `id = $1 AND lease_version = $2 AND status = 'running'` and
  must touch exactly one row, otherwise it rolls back and stops.
- **Failures**: `classify(err)` → deferred (empty bucket / open breaker: back to pending, no attempt
  counted), transient (retry after `min(1h, 30s·2^n) + 0-30 %`), permanent (failed; 401/403 also
  marks the site `auth_failed`). A lease that expires on the last attempt becomes `unknown`.
- **SIGTERM**: stop claiming, wait up to one lease for the steps in flight, exit 0.

## Steps and their keys

Every external effect has a key the next attempt can look up before it spends anything:

| Step | Checked first (free) | Call | Recorded by COMPLETE |
| --- | --- | --- | --- |
| verify | `sites.verified_at` within 10 min | `adapter.verify` | `sites.verified_at` |
| text | - | `llm.generate(brief)` | title, slug, body_html, image_prompt; usage |
| image_submit | - | `image.submit(prompt)` | job id → next row's `provider_ref` |
| image_fetch | `HEAD articles/<id>/cover.jpg` | poll the job (1 s, up to 120 s), download, crop 1200×630 JPEG q80, PUT | usage |
| upload | `findMedia('ryze-<id>.jpg')` | `uploadMedia` | remote_media_id |
| draft | `findBySlug(slug)` | `createDraft` (a slug conflict adopts the existing post) | remote_post_id |
| publish | `getStatus(post)`: already live → keep its URL | `publish` | remote_url, published_at |

Provider calls go through `withQuota` (`provider:llm` takes 4000 units per article, `provider:image`
one per job); polling and downloading are free and not metered. Platform calls take one unit of
`site:<id>` each.

## Notes on inputs

- `db/schema.sql` and `db/schema_test.sql` were not part of the build spec I received, so they were
  written from its description (tables, columns, the CLAIM / RENEW / COMPLETE / RETRY / DEFER / FAIL /
  QUOTA / BREAKER statements). The statements in `packages/core/src/db.ts` are checked against both
  files by `packages/core/test/statements.test.ts`.
- The official `minio/minio` and `minio/mc` images are no longer pullable, so Compose uses the
  Bitnami builds of the same binaries (`bitnamilegacy/minio`, `bitnamilegacy/minio-client`).
