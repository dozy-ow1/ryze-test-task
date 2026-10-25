// Applies db/schema.sql unless its tables already exist, then seeds the provider quota rows.
// Runs from the repo root (`pnpm migrate`) and in the worker image (`node dist/scripts/migrate.js`).
import { readFile } from 'node:fs/promises';
import { createPool, loadConfig, migrateConfig, SQL, tx } from '@ryze/core';

const { DATABASE_URL } = loadConfig(migrateConfig);
const db = createPool(DATABASE_URL, 1);

try {
  const { rows } = await db.query<{ present: boolean }>(
    `SELECT to_regclass('operations') IS NOT NULL AS present`,
  );
  if (rows[0]?.present) {
    console.log('migrate: tables exist, db/schema.sql not applied');
  } else {
    const schema = await readFile('db/schema.sql', 'utf8');
    await tx(db, (client) => client.query(schema));
    console.log('migrate: applied db/schema.sql');
  }
  await db.query(SQL.SEED);
  console.log('migrate: provider quotas seeded');
} finally {
  await db.end();
}
