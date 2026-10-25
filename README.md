# Ryze publishing pipeline

A TypeScript workspace that generates an article and cover image, uploads them to a customer's
WordPress or Shopify site, and publishes the post. Postgres holds both the queue and the execution
ledger. Workers recover expired leases and look up previous platform effects before repeating writes.

## Run locally

Needs Docker Compose v2, Node 22+ and pnpm 10.

```sh
corepack enable
pnpm install
pnpm demo
```

The demo builds a separate, temporary Compose project with its own image tags, database, object storage
and random localhost ports. It forces fake providers and demo credentials before starting any service,
never reads your `.env`, and removes its containers and volumes when it finishes. The normal
`ryze` project and its data are left alone.

For a persistent development stack:

```sh
cp .env.example .env
docker compose up -d --build --wait
pnpm seed
curl http://localhost:8080/articles/summary
```

Published ports bind to localhost. Set `POSTGRES_PORT` in `.env` if 5432 is already occupied. Worker
shutdown gets 130 seconds in Compose so ordinary stops can drain calls in flight.

```sh
pnpm lint
pnpm typecheck
pnpm test
E2E=1 pnpm test   # also runs the isolated demo with 50 articles and no kills
```

Database tests need the development Postgres (`docker compose up -d --wait postgres`). Each file
creates a throwaway schema; tests do not reset development tables.

## Structure

| Package / path | Responsibility |
| --- | --- |
| `packages/api` | HTTP intake, site credentials, article status and explicit retries |
| `packages/worker` | Claim loop, lease lifecycle, pipeline steps and reconciliation |
| `packages/core` | Validated configuration, database queries, quotas, providers and platform HTTP adapters |
| `packages/fake-providers` | Fault-injected text and asynchronous image generation |
| `packages/fake-platforms` | In-memory WordPress and Shopify contracts with fault-injected writes |
| `db/migrations` | Ordered, checksummed schema migrations |
| `scripts` | Development seed, isolated acceptance demo, migration and real-account smoke run |

Tests live beside their modules as `*.spec.ts` and are excluded from production builds. Files use
kebab case, provider/platform factories use `create...`, and lint requires braces. Keep HTTP routes
with their domain rather than adding controller/service/repository layers for simple queries.

Service entrypoints validate `process.env` through `core/config.ts`. Credentials and destinations
belong in the environment; worker limits live in `worker/settings.ts`.

Services communicate through database rows. The API never calls a provider or platform.

```text
POST /articles → Postgres operations
                     ↓ generate pool (2 workers, concurrency 8 each)
                verify → text → image-submit → image-fetch → object storage
                     ↓ publish pool (2 workers, concurrency 16 each)
                upload → draft → publish
                     ↓
                WordPress / Shopify
```

Synchronous image providers skip `image-submit`; `image-fetch` generates and stores the cover.
Step names stored in the database remain `image_submit` and `image_fetch`.

## Intake API

No API authentication or tenant authorization is included. Keep the supplied localhost binding;
put access control in front of the API before exposing it beyond your machine.

| Route | Behavior |
| --- | --- |
| `POST /sites {platform, base_url, token}` | 201 `{id}`; encrypts credentials with AES-256-GCM and creates a site quota |
| `PATCH /sites/:id {token}` | Replaces credentials, reactivates the site, clears cached verification and its circuit breaker; returns 200 `{id}` |
| `POST /articles {site_id, brief, idempotency_key}` | 202 `{article_id}` when new; 200 with the original ID when repeated |
| `POST /articles/bulk {items}` | Up to 1000 items; transactional intake and per-item `{article_id, created}` results |
| `GET /articles/:id` | Article and operation status, attempts and errors |
| `GET /articles/summary` | Aggregate article and operation counts |
| `POST /articles/:id/retry` | 202 when the latest operation is failed or unknown; otherwise 409 |
| `GET /healthz`, `GET /readyz` | Liveness; database-backed readiness |

Site roots must use HTTP(S), with no embedded credentials, query string or fragment. Outbound HTTP
rejects private network destinations, including resolved DNS addresses; workers allow the exact
Compose fake-service hostnames. This is independent of API authentication.

Single and bulk repeated keys return existing articles even if their site has since become inactive.
New articles require active sites. Bulk requests fail atomically if any new item is invalid.

After repairing a platform credential, replace it with `PATCH /sites/:id`, then explicitly retry the
failed articles. Unknown operations require checking the platform first: a prior request may have
succeeded. Credential replacement does not automatically restart articles.

## Execution and recovery

`worker --pool=generate` and `worker --pool=publish` share the runner. Claims use
`FOR UPDATE SKIP LOCKED`; each claim advances a lease version. Completion atomically records the
operation result, updates its article fields and creates the next step. Database writes are fenced
by operation ID, lease version and running status.

Leases renew every third of their duration (120 seconds for generate, 60 for publish). Losing a lease
aborts the step, including outbound calls, and prevents further external effects. A separate expiry
watchdog also handles a renewal query that hangs. A request already accepted by a remote service may
still finish after cancellation.

Transient failures back off from 30 seconds exponentially, capped at one hour plus jitter. Empty
quota buckets and open circuit breakers defer work without consuming an attempt. Permanent errors
fail the operation; platform authentication failures also disable the site. Provider credential
failures leave customer sites active. An expired lease on the last attempt becomes `unknown`.

| Step | Recovery key / behavior |
| --- | --- |
| verify | Cached site verification, valid for 10 minutes; concurrent stale checks can both verify |
| text | Saves title, HTML, image prompt and a slug containing the full article UUID |
| image_submit | Saves provider job ID for the next step |
| image_fetch | Polls that job or generates synchronously; checks the article's object key before generating, then crops a 1200×630 JPEG |
| upload | Looks up `ryze-<article UUID>.jpg` before uploading |
| draft | Looks up the article slug before creating; rejects a remote post explicitly owned by a different article |
| publish | Checks whether the recorded remote post is already live before publishing |

Paid provider calls use shared quota rows. Site steps reserve quota for their lookup and write
together. Image polling, downloading and object storage are free in this model. Shared verification
timestamps reduce repeated checks, but do not serialize simultaneous verifications.

Text generation or image generation can be paid twice if a worker dies or loses a response after
the provider accepts work but before its result becomes durable. A database fence cannot make an
external service transactional. Late remote writes and delayed platform search visibility can also
create duplicate drafts or media; strict exactly-once publication across arbitrary real platforms
is not guaranteed.

## Acceptance demo and fakes

`pnpm demo` posts 300 articles across two fake sites, repeats the first 20 intake requests, injects
15% write/provider faults, and kills one generate and one publish worker at 20 and 60 seconds.
It checks worker restarts, all articles live, exactly one post and media item per article, matching
site/post/image identities, no leftover drafts, reconciliation and explained extra provider charges.
The 15-minute deadline can be exceeded when late retry backoffs accumulate.

Faults are `429` (Retry-After 2), `500`, held connection timeout, slow response, and
`complete_then_drop` (effect succeeds, response disappears). Fake platform faults apply to writes;
fake provider faults apply to the two paid calls. Their admin routes expose/reset in-memory state.

The fake contracts are intentionally smaller than real platforms. Fake WordPress rejects duplicate
slugs where real WordPress may rename them. Shopify covers use the same inline attachment flow
in both modes. Fake media stores metadata rather than image bytes. Passing this demo establishes
the supplied fake contracts and does not establish readiness for arbitrary live accounts.

## Real accounts

The persistent stack reads `.env`; restart/recreate services after changing provider configuration.

| Setting | Behavior |
| --- | --- |
| `LLM_PROVIDER=anthropic`, `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` | Anthropic Messages API; worker owns retries; structured article output and a concise validated prompt |
| `IMAGE_PROVIDER=openai`, `OPENAI_API_KEY`, `OPENAI_IMAGE_MODEL` | Synchronous OpenAI image generation; cover stored under its article key |
| WordPress `base_url` | REST root, e.g. `https://blog.example.com/wp-json`; token is `user:application password` |
| Shopify `base_url` | `https://<store>.myshopify.com/admin/api/2026-10/blogs/<blog id>`; token is the Admin API access token |

Real generation has a 120-second deadline. Timing out or canceling does not establish that a call
was unbilled. Prices are attached only for recognized models; unrecognized model cost stays unknown.

WordPress needs the article ownership meta key registered to preserve that marker. Without it the
adapter falls back to the UUID-bearing slug:

```php
<?php
/* Plugin Name: Ryze article id */
add_action('init', fn () => register_post_meta('post', 'ryze_article_id', [
    'type' => 'string', 'single' => true, 'show_in_rest' => true,
]));
```

`pnpm smoke` publishes one article per configured real site and incurs provider charges. Configure
`WORDPRESS_URL`, `WORDPRESS_USER`, `WORDPRESS_APP_PASSWORD` and/or `SHOPIFY_STORE`,
`SHOPIFY_ACCESS_TOKEN`, `SHOPIFY_BLOG_ID` alongside the real provider keys, then start the persistent
stack and run it. Live accounts have not been validated by the repository's offline tests.

## Migrations and reconciliation

The migration runner records ordered SQL file checksums and uses a transaction-scoped advisory lock
for concurrent deploys. Applied migrations must stay unchanged; add another file for schema updates.
An existing database created before version tracking is refused. Back it up and review its schema
against `db/migrations/001-initial.sql` before explicitly running `pnpm migrate --baseline` with
`DATABASE_URL` targeting that database. Fresh demo projects need no baseline.

`worker --mode=reconcile` runs once; Compose repeats it every minute. It reports operation counts,
published articles, known recorded spend, the count of operations with unknown cost, and running
operations older than 15 minutes. On the fakes it
also lists posts through `/_admin/inspect`, deletes stray drafts through quota-controlled adapters,
and reports live strays for manual review. Individual cleanup failures do not suppress the report;
the next run can retry them. Real platform enumeration and media-orphan cleanup are not implemented.

Other exclusions: Kubernetes, Webflow/Wix, Redis, KMS, PgBouncer, metrics dashboards, batch generation
(the reserved `batches` table is unused), partitioning and API authentication/authorization.
