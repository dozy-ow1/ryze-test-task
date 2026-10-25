# Ryze publishing pipeline (minimal version)

Generates SEO articles and publishes them to customers' sites: text (LLM) → cover image (image
model) → upload to the customer's platform → publish. Postgres is the only source of truth; workers
can be killed at any moment and every article still ends up live exactly once, with its image, without
paying twice for text or images already generated.

## Quick start

```sh
pnpm install
pnpm demo        # starts the stack (docker compose up -d --build --wait) and runs the acceptance test
```

`pnpm demo` copies `.env.example` to `.env` when there is none. If port 5432 is taken on your machine,
set `POSTGRES_PORT=5433` in `.env` (Compose publishes Postgres on it; the tests read it too).

Tests (`pnpm test`) need the Compose Postgres (`docker compose up -d --wait postgres`); each test
file works in its own throwaway schema. `E2E=1 pnpm test` adds the end-to-end run (the demo with 50
articles and no kills). The SQL contract can also be checked straight in psql (30 assertions, rolled
back afterwards):

```sh
docker compose exec postgres psql -U ryze -d ryze -v ON_ERROR_STOP=1 -f /db/schema_test.sql
```

## The demo

`pnpm demo` (`scripts/demo.ts`) is the acceptance test:

1. `docker compose up -d --build --wait`, empty database, `POST /_admin/reset` on both fakes.
2. A WordPress and a Shopify site on the fake platforms, each failing 15 % of its writes with all
   five fault kinds; the fake providers fail 15 % of the paid calls the same way.
3. `POST /articles/bulk` with 300 articles (150 per site), then the first 20 posted again: 200 and
   the same ids.
4. At t+20 s and t+60 s one `worker-generate` and one `worker-publish` container are killed with
   SIGKILL; Compose restarts them.
5. Wait until no operation is pending or running (15 minutes at most), run the reconciler once.
6. Check, against what the fakes recorded: 300 published, 300 live posts, one post and one media
   item per article, every post carries its article id, no shared slugs, no drafts left, no failed
   or unknown operation, and every provider charge beyond one per article explained:
   `text_calls = 300 + complete_then_drop + killed` with `killed ≤ 16` (likewise `image_jobs`).

Sample output (the end of a run; the progress lines every 5 s are cut):

```
t+21s  kill -9: worker-generate 8517a1e23945, worker-publish bfb195c50e3f
t+61s  kill -9: worker-generate 8517a1e23945, worker-publish bfb195c50e3f
...
t+797s  published 300/300, operations pending or running: 0
PASS  300 articles published
PASS  300 live posts on the platforms (found 300)
PASS  exactly one post per article
PASS  every live post carries an article_id
PASS  no two posts share a slug
PASS  zero drafts left (found 0)
      media orphans: 0
PASS  exactly one media item per article
      text_calls = 318 = 300 articles + 15 complete_then_drop + 3 lost to kills
PASS  text_calls: paid-twice calls explained (kills ≤ 16)
      image_jobs = 314 = 300 articles + 14 complete_then_drop + 0 lost to kills
PASS  image_jobs: paid-twice calls explained (kills ≤ 16)
PASS  no operation is failed or unknown

outcomes per step (attempts = failed attempts that were retried):
  step          succeeded  failed  unknown  attempts  max
  verify              300       0        0         0    0
  text                300       0        0        52    2
  image_submit        300       0        0        51    2
  image_fetch         300       0        0         0    0
  upload              300       0        0        36    3
  draft               300       0        0        41    3
  publish             300       0        0        39    2

provider spend $15.0693; recorded in operations.usage $14.3672; stray drafts deleted by the reconciler: 0; drained in 13.3 min

DEMO PASSED
```

The 15-minute budget is tight by construction: the site buckets (2 calls/s, two calls per
publish-pool step) put a floor of about 7.5 minutes under the publish phase, and with 15 % faults
and the 30 s · 2^n backoff, a step that fails three or four times in a row adds 3.5 to 7.5 minutes
to its article. A typical run drains in 10 to 14 minutes.

The kill is `docker exec <container> sh -c 'kill -9 $(pidof node)'` rather than `docker kill`:
Docker records `docker kill` as a manual stop and the restart policy then leaves the container down.
Workers run with `init: true`, so node is not PID 1 and dies exactly as on a crash.

## Fakes

- **fake-providers** (8091): `POST /v1/text`, `POST /v1/images` (asynchronous jobs, ready after
  2-5 s), polling and download, `/_admin/counters` (work done and spend, faults by kind),
  `/_admin/reset`, `/_admin/faults`. Faults hit only the two paid calls.
- **fake-platforms** (8092): WordPress (`/wordpress/wp/v2/...`) and Shopify
  (`/shopify/admin/api/2026-10/...`) in memory per token, `/_admin/sites` (register a token and its
  faults), `/_admin/inspect`, `/_admin/reset`. Faults hit writes (POST/PUT) only: the property
  under test is that writes are never lost or duplicated; faulty reads would only add retries.
- Fault kinds: `429` (Retry-After 2), `500`, `timeout` (socket held 40 s; the client gives up at
  30 s), `slow` (2-10 s, then normal), `complete_then_drop` (the work or write happens, then the
  socket is destroyed without an answer).

## Reconciler

`worker --mode=reconcile` runs once (Compose loops it every 60 s) and prints a JSON report:

- **Strays**: posts on the platforms that carry one of our article ids although that article
  recorded a different post. Drafts are deleted through the adapter; live ones are only reported.
  A post whose article has not recorded any post yet belongs to a draft step still in flight and
  is left alone. In this version the list comes from the fake's `/_admin/inspect`.
- **Stuck**: running operations not updated for 15 minutes are logged (leases already make them
  reclaimable; this is for alerting).
- **Report**: operations per step and status, articles published, spend summed from
  `operations.usage`.

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
one per job); polling and downloading are free and not metered. Each publish-pool step takes two units
of `site:<id>` in one go, for its lookup and its write together: if the lookup took its own unit,
then under contention lookups would keep spending the units the writes wait for, and every write
would be deferred again and again (the first full demo run stalled exactly like that).

## Notes on inputs

- `db/schema.sql` and `db/schema_test.sql` were not part of the build spec I received, so they were
  written from its description (tables, columns, the CLAIM / RENEW / COMPLETE / RETRY / DEFER / FAIL /
  QUOTA / BREAKER statements). The statements in `packages/core/src/db.ts` are checked against both
  files by `packages/core/test/statements.test.ts`.
- The official `minio/minio` and `minio/mc` images are no longer pullable, so Compose uses the
  Bitnami builds of the same binaries (`bitnamilegacy/minio`, `bitnamilegacy/minio-client`).
