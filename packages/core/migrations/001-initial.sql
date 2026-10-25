-- Ryze publishing pipeline: the only source of truth (Postgres 16).
-- Initial schema. Never edit after deployment; add a numbered migration.
--
-- The queue and the per-step ledger are the same table (operations). A step's result, its status
-- change and the next step's row commit in one transaction. Runtime statements live
-- in packages/core/src/queries.ts.

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
  slug            text,                  -- text: slugify(title) plus full article id
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
