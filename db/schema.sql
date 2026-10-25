-- Ryze publishing pipeline: the only source of truth (Postgres 16).
-- Applied as is by `pnpm migrate` (scripts/migrate.ts) when the tables do not exist yet.
--
-- The queue and the per-step ledger are the same table (operations). A step's result, its status
-- change and the next step's row commit in one transaction. The statements the services run are
-- at the end of this file; packages/core uses them literally (a unit test diffs them against it).

CREATE TABLE sites (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  platform    text NOT NULL CHECK (platform IN ('wordpress', 'shopify')),
  base_url    text NOT NULL,             -- API root the adapter appends its routes to
  token_enc   bytea NOT NULL,            -- AES-256-GCM with SITE_TOKEN_KEY: iv(12) || tag(16) || ciphertext
  status      text NOT NULL DEFAULT 'active'
              CHECK (status IN ('active', 'auth_failed')), -- auth_failed: a call got 401/403
  verified_at timestamptz,               -- last successful verify; the verify step skips its call for 10 min
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE articles (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id         uuid NOT NULL REFERENCES sites (id),
  idempotency_key text NOT NULL,         -- chosen by the client; a repeated POST returns the same article
  brief           text NOT NULL,
  -- Outputs. Each column is written by exactly one step, in that step's COMPLETE transaction.
  title           text,                  -- text
  slug            text,                  -- text: slugify(title) || '-' || first 8 chars of id
  body_html       text,                  -- text
  image_prompt    text,                  -- text
  remote_media_id text,                  -- upload: the platform's id for ryze-<id>.jpg
  remote_post_id  text,                  -- draft: the platform's post / article id
  remote_url      text,                  -- publish: public URL
  published_at    timestamptz,           -- publish
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (site_id, idempotency_key)      -- intake idempotency
);
-- The cover image is never stored here, nor is its key: it is always articles/<id>/cover.jpg.

CREATE TABLE operations (
  id            bigserial PRIMARY KEY,
  article_id    uuid NOT NULL REFERENCES articles (id),
  step          text NOT NULL CHECK (step IN
                  ('verify', 'text', 'image_submit', 'image_fetch', 'upload', 'draft', 'publish')),
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN
                  ('pending', 'running', 'succeeded', 'failed', 'unknown')),
                -- unknown: the lease ran out on the last allowed attempt, so whether its call took
                -- effect is not known; only POST /articles/:id/retry makes it runnable again
  attempts      int NOT NULL DEFAULT 0,  -- failed attempts: retries and lost leases, not deferrals
  due_at        timestamptz NOT NULL DEFAULT now(), -- pending: runnable from; running: lease expiry
  lease_version bigint NOT NULL DEFAULT 0, -- fencing token, +1 on every claim
  provider_ref  text,                    -- image_fetch: the image job id, set when image_submit completes
  usage         jsonb,                   -- provider usage and price, e.g. {"input_tokens":812,"output_tokens":604,"cost_usd":0.0115}
  last_error    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(), -- last status change; RENEW does not touch it
  UNIQUE (article_id, step)              -- one row per (article, step)
);
-- The claim scan: due pending rows and expired leases, oldest first.
CREATE INDEX operations_due ON operations (due_at) WHERE status IN ('pending', 'running');

-- Batch API submissions. Present for the Batch mode; unused in the minimal version.
CREATE TABLE batches (
  id                bigserial PRIMARY KEY,
  provider          text NOT NULL CHECK (provider IN ('llm', 'image')),
  provider_batch_id text UNIQUE,         -- set once submitted
  status            text NOT NULL DEFAULT 'open'
                    CHECK (status IN ('open', 'submitted', 'ended', 'failed')),
  operation_ids     bigint[] NOT NULL DEFAULT '{}',
  usage             jsonb,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- One row per scope ('site:<uuid>', 'provider:llm', 'provider:image'): a token bucket plus a circuit
-- breaker, shared by every worker process.
CREATE TABLE quotas (
  scope      text PRIMARY KEY,
  capacity   double precision NOT NULL,  -- bucket size in units (calls; tokens for provider:llm)
  refill     double precision NOT NULL CHECK (refill > 0), -- units per second
  tokens     double precision NOT NULL,  -- units available at tokens_at
  tokens_at  timestamptz NOT NULL DEFAULT now(), -- refill reference; in the future after a 429
  failures   int NOT NULL DEFAULT 0,     -- consecutive outage failures (5xx, timeout, connection)
  open_until timestamptz                 -- breaker open (calls deferred) until then; NULL = closed
);

-- =================================================================================================
-- Statements. $n are bind parameters. Every write to a claimed operation carries
-- `WHERE id = $1 AND lease_version = $2 AND status = 'running'` and must affect exactly one row;
-- zero rows means another worker owns it: roll back and stop.
-- =================================================================================================
--
-- INTAKE (POST /articles, one transaction): $1 site_id, $2 idempotency_key, $3 brief.
--
--   INSERT INTO articles (site_id, idempotency_key, brief) VALUES ($1, $2, $3)
--   ON CONFLICT (site_id, idempotency_key) DO NOTHING
--   RETURNING id
--
-- and when a row came back, its first operation ($1 article_id):
--
--   INSERT INTO operations (article_id, step) VALUES ($1, 'verify')
--
-- otherwise the existing id ($1 site_id, $2 idempotency_key):
--
--   SELECT id FROM articles WHERE site_id = $1 AND idempotency_key = $2
--
-- BULK INTAKE (POST /articles/bulk, one transaction): $1 site ids, $2 keys, $3 briefs.
--
--   INSERT INTO articles (site_id, idempotency_key, brief)
--   SELECT * FROM unnest($1::uuid[], $2::text[], $3::text[])
--   ON CONFLICT (site_id, idempotency_key) DO NOTHING
--   RETURNING id, site_id, idempotency_key
--
-- then the first operation of each new article ($1 article ids):
--
--   INSERT INTO operations (article_id, step) SELECT unnest($1::uuid[]), 'verify'
--
-- and the id of every item, new or not ($1 site ids, $2 keys):
--
--   SELECT a.id, a.site_id, a.idempotency_key
--   FROM articles a
--   JOIN unnest($1::uuid[], $2::text[]) AS k (site_id, idempotency_key)
--     ON a.site_id = k.site_id AND a.idempotency_key = k.idempotency_key
--
-- CLAIM: $1 steps, $2 lease seconds, $3 limit, $4 max attempts.
-- Takes due pending rows and expired leases. A reclaimed lease counts as a failed attempt; on the
-- last attempt the row becomes 'unknown' instead and the runner skips it.
--
--   WITH picked AS (
--     SELECT id FROM operations
--     WHERE step = ANY ($1::text[])
--       AND status IN ('pending', 'running')
--       AND due_at <= now()
--     ORDER BY due_at
--     LIMIT $3
--     FOR UPDATE SKIP LOCKED
--   )
--   UPDATE operations o
--   SET status = CASE WHEN o.status = 'running' AND o.attempts + 1 >= $4
--                     THEN 'unknown' ELSE 'running' END,
--       attempts = o.attempts + CASE WHEN o.status = 'running' THEN 1 ELSE 0 END,
--       last_error = CASE WHEN o.status = 'running' THEN 'lease expired' ELSE o.last_error END,
--       lease_version = o.lease_version + 1,
--       due_at = now() + make_interval(secs => $2),
--       updated_at = now()
--   FROM picked
--   WHERE o.id = picked.id
--   RETURNING o.id, o.article_id, o.step, o.status, o.attempts, o.lease_version, o.provider_ref
--
-- RENEW: $1 id, $2 lease_version, $3 lease seconds. Zero rows: the lease is lost, abort the step.
--
--   UPDATE operations SET due_at = now() + make_interval(secs => $3)
--   WHERE id = $1 AND lease_version = $2 AND status = 'running'
--
-- COMPLETE: one transaction. First $1 id, $2 lease_version, $3 usage:
--
--   UPDATE operations SET status = 'succeeded', usage = $3, last_error = NULL, updated_at = now()
--   WHERE id = $1 AND lease_version = $2 AND status = 'running'
--
-- then, only when that updated exactly one row, the step's own columns ($1 article or site id):
--
--   verify:  UPDATE sites SET verified_at = now() WHERE id = $1
--   text:    UPDATE articles SET title = $2, slug = $3, body_html = $4, image_prompt = $5 WHERE id = $1
--   upload:  UPDATE articles SET remote_media_id = $2 WHERE id = $1
--   draft:   UPDATE articles SET remote_post_id = $2 WHERE id = $1
--   publish: UPDATE articles SET remote_url = $2, published_at = now() WHERE id = $1
--
-- and the next step's row (NEXT: $1 article_id, $2 step, $3 provider_ref), then COMMIT:
--
--   INSERT INTO operations (article_id, step, provider_ref) VALUES ($1, $2, $3)
--   ON CONFLICT (article_id, step) DO NOTHING
--
-- RETRY: $1 id, $2 lease_version, $3 delay seconds, $4 error.
--
--   UPDATE operations
--   SET status = 'pending', attempts = attempts + 1, due_at = now() + make_interval(secs => $3),
--       last_error = $4, updated_at = now()
--   WHERE id = $1 AND lease_version = $2 AND status = 'running'
--
-- DEFER: $1 id, $2 lease_version, $3 until. Not an attempt: attempts stays as it is.
--
--   UPDATE operations SET status = 'pending', due_at = $3, updated_at = now()
--   WHERE id = $1 AND lease_version = $2 AND status = 'running'
--
-- FAIL: $1 id, $2 lease_version, $3 error. On 401/403 the same transaction also runs
-- `UPDATE sites SET status = 'auth_failed' WHERE id = $1` with the site id.
--
--   UPDATE operations SET status = 'failed', attempts = attempts + 1, last_error = $3, updated_at = now()
--   WHERE id = $1 AND lease_version = $2 AND status = 'running'
--
-- RETRY ARTICLE (POST /articles/:id/retry): $1 article_id. Zero rows: 409.
--
--   UPDATE operations
--   SET status = 'pending', attempts = 0, due_at = now(), last_error = NULL, updated_at = now()
--   WHERE id = (SELECT max(id) FROM operations WHERE article_id = $1)
--     AND status IN ('failed', 'unknown')
--   RETURNING id
--
-- QUOTA TAKE: $1 scope, $2 units. Refills the bucket, then takes $2 units if they are there and the
-- breaker is not open. wait_sec is how long until $2 units will be there. No row: not metered.
--
--   WITH q AS (
--     SELECT scope, refill, tokens_at, open_until, failures,
--            LEAST(capacity, tokens + refill * GREATEST(0, EXTRACT(EPOCH FROM now() - tokens_at))) AS avail
--     FROM quotas WHERE scope = $1
--     FOR UPDATE
--   ), took AS (
--     UPDATE quotas SET tokens = q.avail - $2::float8, tokens_at = GREATEST(q.tokens_at, now())
--     FROM q
--     WHERE quotas.scope = q.scope
--       AND q.avail >= $2::float8
--       AND (q.open_until IS NULL OR q.open_until <= now())
--     RETURNING quotas.scope
--   )
--   SELECT EXISTS (SELECT 1 FROM took) AS allowed,
--          COALESCE(q.open_until > now(), false) AS open,
--          q.open_until,
--          q.failures,
--          (GREATEST(0, EXTRACT(EPOCH FROM q.tokens_at - now()))
--            + GREATEST(0, $2::float8 - q.avail) / q.refill)::float8 AS wait_sec
--   FROM q
--
-- QUOTA DRAIN (the platform answered 429): $1 scope, $2 Retry-After seconds.
--
--   UPDATE quotas SET tokens = 0, tokens_at = GREATEST(tokens_at, now() + make_interval(secs => $2))
--   WHERE scope = $1
--
-- QUOTA SET (Shopify reports its bucket on every response): $1 scope, $2 units available now.
--
--   UPDATE quotas SET tokens = LEAST(capacity, $2), tokens_at = now() WHERE scope = $1
--
-- BREAKER PROBE: $1 scope. A row back means the breaker was open and its 30 s are over: this call
-- is the half-open probe (it runs without taking quota) and every other caller waits 30 s more.
--
--   UPDATE quotas SET open_until = now() + interval '30 seconds'
--   WHERE scope = $1 AND failures >= 5 AND open_until <= now()
--   RETURNING scope
--
-- BREAKER FAILURE (5xx, timeout, connection error): $1 scope. The fifth one in a row opens it.
--
--   UPDATE quotas
--   SET failures = failures + 1,
--       open_until = CASE WHEN failures + 1 >= 5 THEN now() + interval '30 seconds' ELSE open_until END
--   WHERE scope = $1
--
-- BREAKER RESET (a success while failures > 0): $1 scope.
--
--   UPDATE quotas SET failures = 0, open_until = NULL WHERE scope = $1 AND failures > 0
--
-- SITE QUOTA (POST /sites): $1 scope, $2 capacity, $3 refill. Starts full.
--
--   INSERT INTO quotas (scope, capacity, refill, tokens) VALUES ($1, $2, $3, $2)
--
-- SEED (scripts/migrate.ts, every run): the provider buckets.
--
--   INSERT INTO quotas (scope, capacity, refill, tokens) VALUES
--     ('provider:llm', 400000, 6666, 400000),
--     ('provider:image', 10, 2, 10)
--   ON CONFLICT (scope) DO NOTHING
