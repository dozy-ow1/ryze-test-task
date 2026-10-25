import { readFileSync } from 'node:fs';
import { SQL } from '@ryze/core';
import { describe, expect, it } from 'vitest';

// The statements live in three places: the comments of db/schema.sql (the contract), db.ts (what
// runs) and db/schema_test.sql (the reference scenarios). Whitespace aside, they must be identical.
const squash = (s: string) => s.replace(/\s+/g, ' ').trim();
const schema = squash(readFileSync('db/schema.sql', 'utf8').replace(/^\s*--/gm, ''));
const scenarios = squash(readFileSync('db/schema_test.sql', 'utf8'));

const IN_SCENARIOS = new Set([
  'INTAKE',
  'CLAIM',
  'RENEW',
  'COMPLETE',
  'NEXT',
  'RETRY',
  'DEFER',
  'FAIL',
  'RETRY_ARTICLE',
  'QUOTA_TAKE',
  'QUOTA_DRAIN',
  'BREAKER_PROBE',
  'BREAKER_FAILURE',
  'BREAKER_RESET',
]);

describe('SQL statements', () => {
  it.each(Object.entries(SQL))('%s is written in db/schema.sql', (_name, sql) => {
    expect(schema).toContain(squash(sql));
  });

  it.each(Object.entries(SQL).filter(([name]) => IN_SCENARIOS.has(name)))(
    '%s is the one db/schema_test.sql exercises',
    (_name, sql) => {
      expect(scenarios).toContain(squash(sql));
    },
  );
});
