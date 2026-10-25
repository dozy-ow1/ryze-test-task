-- Reference scenarios for the statements at the end of schema.sql: 30 assertions.
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/schema_test.sql
--
-- Everything runs in one transaction inside a throwaway schema and is rolled back, so the real
-- tables are never touched. now() stands still inside a transaction: "time passes" by moving
-- due_at, tokens_at and open_until into the past. Two concurrent claimers need two sessions; that
-- case is in packages/core/test/sql.test.ts, which ports the rest of this file too.
\set ON_ERROR_STOP 1
\set QUIET 1
BEGIN;
CREATE SCHEMA ryze_schema_test;
SET LOCAL search_path = ryze_schema_test;
\ir schema.sql

-- The statements, verbatim, wrapped as functions whose arguments are the bind parameters.

CREATE FUNCTION intake(uuid, text, text) RETURNS SETOF uuid LANGUAGE plpgsql AS $f$
BEGIN
  RETURN QUERY EXECUTE $q$
    INSERT INTO articles (site_id, idempotency_key, brief) VALUES ($1, $2, $3)
    ON CONFLICT (site_id, idempotency_key) DO NOTHING
    RETURNING id
  $q$ USING $1, $2, $3;
END $f$;

CREATE FUNCTION claim(text[], float8, int, int)
RETURNS TABLE (id bigint, article_id uuid, step text, status text, attempts int,
               lease_version bigint, provider_ref text)
LANGUAGE plpgsql AS $f$
BEGIN
  RETURN QUERY EXECUTE $q$
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
    RETURNING o.id, o.article_id, o.step, o.status, o.attempts, o.lease_version, o.provider_ref
  $q$ USING $1, $2, $3, $4;
END $f$;

CREATE FUNCTION renew(bigint, bigint, float8) RETURNS int LANGUAGE plpgsql AS $f$
DECLARE n int;
BEGIN
  EXECUTE $q$
    UPDATE operations SET due_at = now() + make_interval(secs => $3)
    WHERE id = $1 AND lease_version = $2 AND status = 'running'
  $q$ USING $1, $2, $3;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $f$;

CREATE FUNCTION complete(bigint, bigint, jsonb) RETURNS int LANGUAGE plpgsql AS $f$
DECLARE n int;
BEGIN
  EXECUTE $q$
    UPDATE operations SET status = 'succeeded', usage = $3, last_error = NULL, updated_at = now()
    WHERE id = $1 AND lease_version = $2 AND status = 'running'
  $q$ USING $1, $2, $3;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $f$;

CREATE FUNCTION next_op(uuid, text, text) RETURNS int LANGUAGE plpgsql AS $f$
DECLARE n int;
BEGIN
  EXECUTE $q$
    INSERT INTO operations (article_id, step, provider_ref) VALUES ($1, $2, $3)
    ON CONFLICT (article_id, step) DO NOTHING
  $q$ USING $1, $2, $3;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $f$;

CREATE FUNCTION retry(bigint, bigint, float8, text) RETURNS int LANGUAGE plpgsql AS $f$
DECLARE n int;
BEGIN
  EXECUTE $q$
    UPDATE operations
    SET status = 'pending', attempts = attempts + 1, due_at = now() + make_interval(secs => $3),
        last_error = $4, updated_at = now()
    WHERE id = $1 AND lease_version = $2 AND status = 'running'
  $q$ USING $1, $2, $3, $4;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $f$;

CREATE FUNCTION defer(bigint, bigint, timestamptz) RETURNS int LANGUAGE plpgsql AS $f$
DECLARE n int;
BEGIN
  EXECUTE $q$
    UPDATE operations SET status = 'pending', due_at = $3, updated_at = now()
    WHERE id = $1 AND lease_version = $2 AND status = 'running'
  $q$ USING $1, $2, $3;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $f$;

CREATE FUNCTION fail(bigint, bigint, text) RETURNS int LANGUAGE plpgsql AS $f$
DECLARE n int;
BEGIN
  EXECUTE $q$
    UPDATE operations SET status = 'failed', attempts = attempts + 1, last_error = $3, updated_at = now()
    WHERE id = $1 AND lease_version = $2 AND status = 'running'
  $q$ USING $1, $2, $3;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $f$;

CREATE FUNCTION retry_article(uuid) RETURNS SETOF bigint LANGUAGE plpgsql AS $f$
BEGIN
  RETURN QUERY EXECUTE $q$
    UPDATE operations
    SET status = 'pending', attempts = 0, due_at = now(), last_error = NULL, updated_at = now()
    WHERE id = (SELECT max(id) FROM operations WHERE article_id = $1)
      AND status IN ('failed', 'unknown')
    RETURNING id
  $q$ USING $1;
END $f$;

CREATE FUNCTION quota_take(text, float8)
RETURNS TABLE (allowed boolean, open boolean, open_until timestamptz, failures int, wait_sec float8)
LANGUAGE plpgsql AS $f$
BEGIN
  RETURN QUERY EXECUTE $q$
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
    FROM q
  $q$ USING $1, $2;
END $f$;

CREATE FUNCTION quota_drain(text, float8) RETURNS int LANGUAGE plpgsql AS $f$
DECLARE n int;
BEGIN
  EXECUTE $q$
    UPDATE quotas SET tokens = 0, tokens_at = GREATEST(tokens_at, now() + make_interval(secs => $2))
    WHERE scope = $1
  $q$ USING $1, $2;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $f$;

CREATE FUNCTION breaker_probe(text) RETURNS int LANGUAGE plpgsql AS $f$
DECLARE n int;
BEGIN
  EXECUTE $q$
    UPDATE quotas SET open_until = now() + interval '30 seconds'
    WHERE scope = $1 AND failures >= 5 AND open_until <= now()
    RETURNING scope
  $q$ USING $1;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $f$;

CREATE FUNCTION breaker_failure(text) RETURNS int LANGUAGE plpgsql AS $f$
DECLARE n int;
BEGIN
  EXECUTE $q$
    UPDATE quotas
    SET failures = failures + 1,
        open_until = CASE WHEN failures + 1 >= 5 THEN now() + interval '30 seconds' ELSE open_until END
    WHERE scope = $1
  $q$ USING $1;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $f$;

CREATE FUNCTION breaker_reset(text) RETURNS int LANGUAGE plpgsql AS $f$
DECLARE n int;
BEGIN
  EXECUTE $q$
    UPDATE quotas SET failures = 0, open_until = NULL WHERE scope = $1 AND failures > 0
  $q$ USING $1;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $f$;

-- Fixtures: one site and three articles that bypass intake.
INSERT INTO sites (id, platform, base_url, token_enc)
VALUES ('5a5a5a5a-0000-4000-8000-000000000001', 'wordpress', 'http://wp.test', '\x00');
INSERT INTO articles (id, site_id, idempotency_key, brief) VALUES
  ('a0000000-0000-4000-8000-000000000002', '5a5a5a5a-0000-4000-8000-000000000001', 'a2', 'b'),
  ('a0000000-0000-4000-8000-000000000003', '5a5a5a5a-0000-4000-8000-000000000001', 'a3', 'b');

-- Intake: a repeated idempotency key creates nothing.
DO $$
DECLARE first uuid; again uuid;
BEGIN
  SELECT intake('5a5a5a5a-0000-4000-8000-000000000001', 'k1', 'a brief') INTO first;
  ASSERT first IS NOT NULL, '1 intake: a new key inserts the article';
  INSERT INTO operations (article_id, step) VALUES (first, 'verify');
  SELECT intake('5a5a5a5a-0000-4000-8000-000000000001', 'k1', 'another brief') INTO again;
  ASSERT again IS NULL
     AND (SELECT count(*) FROM articles WHERE idempotency_key = 'k1') = 1
     AND (SELECT count(*) FROM operations WHERE article_id = first) = 1,
    '2 intake: a repeated key inserts no article and no operation';
END $$;

-- Claim: the pool filter and the fields a claim sets.
INSERT INTO operations (article_id, step)
VALUES ('a0000000-0000-4000-8000-000000000002', 'upload');
INSERT INTO operations (article_id, step, due_at)
VALUES ('a0000000-0000-4000-8000-000000000003', 'text', now() + interval '1 minute');
CREATE TEMP TABLE claimed AS SELECT * FROM claim('{verify,text,image_submit,image_fetch}', 120, 10, 8);
DO $$
BEGIN
  ASSERT (SELECT count(*) FROM claimed) = 1 AND (SELECT step FROM claimed) = 'verify',
    '3 claim: only due rows of the pool''s own steps';
  ASSERT (SELECT status = 'running' AND lease_version = 1 AND attempts = 0 FROM claimed),
    '4 claim: running, lease_version 1, attempts unchanged';
  ASSERT (SELECT due_at = now() + interval '120 seconds' FROM operations
          WHERE id = (SELECT id FROM claimed)),
    '5 claim: due_at becomes the lease expiry';
  ASSERT (SELECT count(*) FROM claim('{verify}', 120, 10, 8)) = 0,
    '6 claim: a live lease is not taken again';
END $$;

-- Guarded completion and chaining.
DO $$
DECLARE op bigint := (SELECT id FROM claimed); art uuid := (SELECT article_id FROM claimed);
        n int;
BEGIN
  ASSERT complete(op, 0, NULL) = 0, '7 complete: a stale lease_version changes nothing';
  n := complete(op, 1, '{"cost_usd": 0.01}');
  ASSERT n = 1
     AND (SELECT status = 'succeeded' AND usage ->> 'cost_usd' = '0.01' AND last_error IS NULL
          FROM operations WHERE id = op),
    '8 complete: the current lease completes, with its usage';
  ASSERT complete(op, 1, NULL) = 0, '9 complete: only a running row completes';
  PERFORM next_op(art, 'text', NULL);
  PERFORM next_op(art, 'text', NULL);
  ASSERT (SELECT count(*) FROM operations
          WHERE article_id = art AND step = 'text' AND status = 'pending' AND due_at <= now()) = 1,
    '10 next: the next step gets one runnable row, however often it is inserted';
END $$;

-- Lease expiry: the worker died; the next claim takes the row over.
INSERT INTO operations (article_id, step, provider_ref)
VALUES ('a0000000-0000-4000-8000-000000000002', 'image_fetch', 'job-1');
DO $$ BEGIN PERFORM claim('{image_fetch}', 120, 10, 8); END $$;
UPDATE operations SET due_at = now() - interval '1 second' WHERE step = 'image_fetch';
CREATE TEMP TABLE reclaimed AS SELECT * FROM claim('{image_fetch}', 120, 10, 8);
DO $$
DECLARE op bigint := (SELECT id FROM reclaimed); stale int; current int; n int;
BEGIN
  ASSERT (SELECT status = 'running' AND attempts = 1 AND lease_version = 2 FROM reclaimed),
    '11 reclaim: a lost lease counts as a failed attempt and gets a new lease';
  ASSERT (SELECT provider_ref FROM reclaimed) = 'job-1', '12 reclaim: provider_ref is kept';
  ASSERT (SELECT last_error FROM operations WHERE id = op) = 'lease expired',
    '13 reclaim: last_error says why';
  stale := renew(op, 1, 120);
  current := renew(op, 2, 60);
  ASSERT stale = 0 AND current = 1
     AND (SELECT due_at = now() + interval '60 seconds' FROM operations WHERE id = op),
    '14 renew: only the current lease extends';
  n := retry(op, 1, 30, 'late') + defer(op, 1, now()) + fail(op, 1, 'late') + complete(op, 1, NULL);
  ASSERT n = 0 AND (SELECT status FROM operations WHERE id = op) = 'running',
    '15 fencing: writes with a stale lease_version affect zero rows';
END $$;

-- A lease that runs out on the last allowed attempt: the outcome of the call is unknown.
INSERT INTO operations (article_id, step, status, attempts, lease_version, due_at)
VALUES ('a0000000-0000-4000-8000-000000000003', 'draft', 'running', 7, 7, now() - interval '1 second');
CREATE TEMP TABLE given_up AS SELECT * FROM claim('{draft}', 60, 10, 8);
DO $$
BEGIN
  ASSERT (SELECT status = 'unknown' AND attempts = 8 FROM given_up),
    '16 reclaim: on the last attempt an expired lease becomes unknown';
  ASSERT (SELECT count(*) FROM claim('{draft}', 60, 10, 8)) = 0, '17 claim: unknown rows are never taken';
END $$;

-- Defer, retry, fail and the retry endpoint, on the image_fetch row (lease 2).
DO $$
DECLARE op bigint := (SELECT id FROM reclaimed); art uuid := (SELECT article_id FROM reclaimed);
        again bigint; n int;
BEGIN
  n := defer(op, 2, now() + interval '5 seconds');
  ASSERT n = 1
     AND (SELECT status = 'pending' AND attempts = 1 AND due_at = now() + interval '5 seconds'
          FROM operations WHERE id = op),
    '18 defer: pending until the given time, attempts unchanged';
  UPDATE operations SET due_at = now() WHERE id = op;
  PERFORM claim('{image_fetch}', 120, 10, 8);
  n := retry(op, 3, 30, 'HTTP 503');
  ASSERT n = 1
     AND (SELECT status = 'pending' AND attempts = 2 AND last_error = 'HTTP 503'
                 AND due_at = now() + interval '30 seconds'
          FROM operations WHERE id = op),
    '19 retry: pending after the backoff, attempts + 1, last_error';
  UPDATE operations SET due_at = now() WHERE id = op;
  PERFORM claim('{image_fetch}', 120, 10, 8);
  n := fail(op, 4, 'HTTP 404');
  ASSERT n = 1
     AND (SELECT status = 'failed' AND last_error = 'HTTP 404' FROM operations WHERE id = op),
    '20 fail: failed, with the error';
  SELECT retry_article(art) INTO again;
  ASSERT again = op
     AND (SELECT status = 'pending' AND attempts = 0 AND last_error IS NULL AND due_at = now()
          FROM operations WHERE id = op),
    '21 retry endpoint: the failed latest operation runs again from zero';
  SELECT retry_article(art) INTO again;
  ASSERT again IS NULL, '22 retry endpoint: only a failed or unknown latest operation';
END $$;

-- Quota: take, wait, refill, drain.
INSERT INTO quotas (scope, capacity, refill, tokens) VALUES ('site:test', 4, 2, 4);
DO $$
DECLARE r record;
BEGIN
  SELECT * INTO r FROM quota_take('site:test', 4);
  ASSERT r.allowed AND (SELECT tokens FROM quotas WHERE scope = 'site:test') = 0,
    '23 quota: a full bucket gives its capacity';
  SELECT * INTO r FROM quota_take('site:test', 1);
  ASSERT NOT r.allowed AND NOT r.open AND r.wait_sec = 0.5,
    '24 quota: an empty bucket refuses and says how long to wait (1 unit at 2/s)';
  UPDATE quotas SET tokens_at = now() - interval '1 second' WHERE scope = 'site:test';
  SELECT * INTO r FROM quota_take('site:test', 1);
  ASSERT r.allowed AND (SELECT tokens FROM quotas WHERE scope = 'site:test') = 1,
    '25 quota: refills 2 units over 1 s';
  PERFORM quota_drain('site:test', 2);
  SELECT * INTO r FROM quota_take('site:test', 1);
  ASSERT NOT r.allowed AND r.wait_sec = 2.5,
    '26 quota: a 429 empties the bucket until Retry-After';
END $$;

-- Breaker: open, half-open, close.
INSERT INTO quotas (scope, capacity, refill, tokens) VALUES ('provider:test', 10, 2, 10);
DO $$
DECLARE r record; first_probe int; second_probe int;
BEGIN
  FOR i IN 1..4 LOOP PERFORM breaker_failure('provider:test'); END LOOP;
  first_probe := breaker_probe('provider:test');
  ASSERT (SELECT failures = 4 AND open_until IS NULL FROM quotas WHERE scope = 'provider:test')
     AND first_probe = 0,
    '27 breaker: closed below five failures';
  PERFORM breaker_failure('provider:test');
  SELECT * INTO r FROM quota_take('provider:test', 1);
  ASSERT r.open AND NOT r.allowed AND r.open_until = now() + interval '30 seconds'
     AND (SELECT tokens FROM quotas WHERE scope = 'provider:test') = 10,
    '28 breaker: the fifth failure opens it for 30 s; takes are refused and take nothing';
  UPDATE quotas SET open_until = now() - interval '1 second' WHERE scope = 'provider:test';
  first_probe := breaker_probe('provider:test');
  second_probe := breaker_probe('provider:test');
  ASSERT first_probe = 1 AND second_probe = 0
     AND (SELECT open_until = now() + interval '30 seconds' FROM quotas WHERE scope = 'provider:test'),
    '29 breaker: after 30 s exactly one caller probes; the rest wait 30 s more';
  PERFORM breaker_reset('provider:test');
  SELECT * INTO r FROM quota_take('provider:test', 1);
  ASSERT r.allowed
     AND (SELECT failures = 0 AND open_until IS NULL FROM quotas WHERE scope = 'provider:test'),
    '30 breaker: a success closes it';
END $$;

ROLLBACK;
\echo 'schema_test.sql: 30 assertions passed'
