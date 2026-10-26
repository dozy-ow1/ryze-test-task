import { expect, it } from 'vitest';
import { type TestDb, testDb } from './database.js';

it('preserves connection parameters while isolating the test schema', async () => {
  const original = process.env.TEST_DATABASE_URL;
  const configured = new URL(original as string);
  configured.searchParams.set('application_name', 'ryze-fixture-test');
  process.env.TEST_DATABASE_URL = configured.toString();
  let scoped: TestDb | undefined;

  try {
    scoped = await testDb();
    const { rows } = await scoped.db.query(
      "SELECT current_schema() AS schema, current_setting('application_name') AS application",
    );
    expect(rows[0].schema).toMatch(/^t_[a-f0-9]+$/);
    expect(rows[0].application).toBe('ryze-fixture-test');
  } finally {
    process.env.TEST_DATABASE_URL = original;
    await scoped?.drop();
  }
});
