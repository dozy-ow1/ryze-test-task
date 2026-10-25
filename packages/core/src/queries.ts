// Queue, intake and shared quota statements. Bind all values; never interpolate user input.
export const SQL = {
  INTAKE: `
    INSERT INTO articles (site_id, idempotency_key, brief) VALUES ($1, $2, $3)
    ON CONFLICT (site_id, idempotency_key) DO NOTHING
    RETURNING id`,
  INTAKE_OP: `INSERT INTO operations (article_id, step) VALUES ($1, 'verify')`,
  INTAKE_EXISTING: `SELECT id FROM articles WHERE site_id = $1 AND idempotency_key = $2`,
  BULK_INTAKE: `
    INSERT INTO articles (site_id, idempotency_key, brief)
    SELECT * FROM unnest($1::uuid[], $2::text[], $3::text[])
    ON CONFLICT (site_id, idempotency_key) DO NOTHING
    RETURNING id, site_id, idempotency_key`,
  BULK_INTAKE_OPS: `INSERT INTO operations (article_id, step) SELECT unnest($1::uuid[]), 'verify'`,
  BULK_INTAKE_IDS: `
    SELECT a.id, a.site_id, a.idempotency_key
    FROM articles a
    JOIN unnest($1::uuid[], $2::text[]) AS k (site_id, idempotency_key)
      ON a.site_id = k.site_id AND a.idempotency_key = k.idempotency_key`,
  CLAIM: `
    WITH picked AS (
      SELECT id FROM operations
      WHERE step = ANY ($1::text[])
        AND status IN ('pending', 'running')
        AND due_at <= now()
      ORDER BY due_at
      LIMIT $3
      FOR UPDATE SKIP LOCKED
    )
    UPDATE operations o
    SET status = CASE WHEN o.status = 'running' AND o.attempts + 1 >= $4
                      THEN 'unknown' ELSE 'running' END,
        attempts = o.attempts + CASE WHEN o.status = 'running' THEN 1 ELSE 0 END,
        last_error = CASE WHEN o.status = 'running' THEN 'lease expired' ELSE o.last_error END,
        lease_version = o.lease_version + 1,
        due_at = now() + make_interval(secs => $2),
        updated_at = now()
    FROM picked
    WHERE o.id = picked.id
    RETURNING o.id, o.article_id, o.step, o.status, o.attempts, o.lease_version, o.provider_ref`,
  RENEW: `
    UPDATE operations SET due_at = now() + make_interval(secs => $3)
    WHERE id = $1 AND lease_version = $2 AND status = 'running'`,
  COMPLETE: `
    UPDATE operations SET status = 'succeeded', usage = $3, last_error = NULL, updated_at = now()
    WHERE id = $1 AND lease_version = $2 AND status = 'running'`,
  WRITE_VERIFIED: `UPDATE sites SET verified_at = now() WHERE id = $1 AND ($2::bytea IS NULL OR token_enc = $2)`,
  WRITE_TEXT: `UPDATE articles SET title = $2, slug = $3, body_html = $4, image_prompt = $5 WHERE id = $1`,
  WRITE_MEDIA: `UPDATE articles SET remote_media_id = $2 WHERE id = $1`,
  WRITE_POST: `UPDATE articles SET remote_post_id = $2 WHERE id = $1`,
  WRITE_PUBLISHED: `UPDATE articles SET remote_url = $2, published_at = now() WHERE id = $1`,
  NEXT: `
    INSERT INTO operations (article_id, step, provider_ref) VALUES ($1, $2, $3)
    ON CONFLICT (article_id, step) DO NOTHING`,
  RETRY: `
    UPDATE operations
    SET status = 'pending', attempts = attempts + 1, due_at = now() + make_interval(secs => $3),
        last_error = $4, updated_at = now()
    WHERE id = $1 AND lease_version = $2 AND status = 'running'`,
  DEFER: `
    UPDATE operations SET status = 'pending', due_at = $3, updated_at = now()
    WHERE id = $1 AND lease_version = $2 AND status = 'running'`,
  FAIL: `
    UPDATE operations SET status = 'failed', attempts = attempts + 1, last_error = $3, updated_at = now()
    WHERE id = $1 AND lease_version = $2 AND status = 'running'`,
  SITE_AUTH_FAILED: `UPDATE sites SET status = 'auth_failed' WHERE id = $1 AND ($2::bytea IS NULL OR token_enc = $2)`,
  RETRY_ARTICLE: `
    UPDATE operations
    SET status = 'pending', attempts = 0, due_at = now(), last_error = NULL, updated_at = now()
    WHERE id = (SELECT max(id) FROM operations WHERE article_id = $1)
      AND status IN ('failed', 'unknown')
    RETURNING id`,
  QUOTA_TAKE: `
    WITH q AS (
      SELECT scope, refill, tokens_at, open_until, failures,
             LEAST(capacity, tokens + refill * GREATEST(0, EXTRACT(EPOCH FROM now() - tokens_at))) AS avail
      FROM quotas WHERE scope = $1
      FOR UPDATE
    ), took AS (
      UPDATE quotas SET tokens = q.avail - $2::float8, tokens_at = GREATEST(q.tokens_at, now())
      FROM q
      WHERE quotas.scope = q.scope
        AND q.avail >= $2::float8
        AND (q.open_until IS NULL OR q.open_until <= now())
      RETURNING quotas.scope
    )
    SELECT EXISTS (SELECT 1 FROM took) AS allowed,
           COALESCE(q.open_until > now(), false) AS open,
           q.open_until,
           q.failures,
           (GREATEST(0, EXTRACT(EPOCH FROM q.tokens_at - now()))
             + GREATEST(0, $2::float8 - q.avail) / q.refill)::float8 AS wait_sec
    FROM q`,
  QUOTA_DRAIN: `
    UPDATE quotas SET tokens = 0, tokens_at = GREATEST(tokens_at, now() + make_interval(secs => $2))
    WHERE scope = $1`,
  QUOTA_SET: `
    UPDATE quotas
    SET tokens = LEAST(tokens, capacity, GREATEST(0, $2)),
        tokens_at = GREATEST(tokens_at, now())
    WHERE scope = $1`,
  BREAKER_PROBE: `
    UPDATE quotas SET open_until = now() + interval '30 seconds'
    WHERE scope = $1 AND failures >= 5 AND open_until <= now()
    RETURNING scope`,
  BREAKER_FAILURE: `
    UPDATE quotas
    SET failures = failures + 1,
        open_until = CASE WHEN failures + 1 >= 5 THEN now() + interval '30 seconds' ELSE open_until END
    WHERE scope = $1`,
  BREAKER_RESET: `UPDATE quotas SET failures = 0, open_until = NULL WHERE scope = $1 AND failures > 0`,
  SITE_QUOTA: `INSERT INTO quotas (scope, capacity, refill, tokens) VALUES ($1, $2, $3, $2)`,
  SEED: `
    INSERT INTO quotas (scope, capacity, refill, tokens) VALUES
      ('provider:llm', 400000, 6666, 400000),
      ('provider:image', 10, 2, 10)
    ON CONFLICT (scope) DO NOTHING`,
} as const;
