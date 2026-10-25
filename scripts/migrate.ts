import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPool, type Database, loadConfig, migrateConfig, SQL, transaction } from '@ryze/core';

const MIGRATION_LOCK = 746593;
const INITIAL_MIGRATION = '001-initial.sql';

// Checksums protect applied files; the transaction lock serializes concurrent deploys.
export async function migrate(db: Database, directory = 'db/migrations', baseline = false) {
  const files = (await readdir(directory)).filter((name) => /^\d+-[\w-]+\.sql$/.test(name)).sort();
  if (files.length === 0) {
    throw new Error(`No migrations in ${directory}`);
  }
  await transaction(db, async (client) => {
    await client.query('SELECT pg_advisory_xact_lock($1)', [MIGRATION_LOCK]);
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const { rows } = await client.query<{ name: string; checksum: string }>(
      'SELECT name, checksum FROM schema_migrations ORDER BY name',
    );
    const applied = new Map(rows.map((row) => [row.name, row.checksum]));
    for (const name of applied.keys()) {
      if (!files.includes(name)) {
        throw new Error(`Applied migration is missing: ${name}`);
      }
    }
    const existing = await client.query("SELECT to_regclass('operations') IS NOT NULL AS present");
    if (existing.rows[0].present && applied.size === 0 && !baseline) {
      throw new Error(
        'Unversioned database: back up and review its schema, then run migrate --baseline',
      );
    }
    for (const name of files) {
      const sql = await readFile(resolve(directory, name), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      if (applied.has(name)) {
        if (applied.get(name) !== checksum) {
          throw new Error(`Applied migration changed: ${name}; add a new migration instead`);
        }
        continue;
      }
      if (!(baseline && existing.rows[0].present && name === INITIAL_MIGRATION)) {
        await client.query(sql);
      }
      await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [
        name,
        checksum,
      ]);
    }
    await client.query(SQL.SEED);
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const { DATABASE_URL } = loadConfig(migrateConfig);
  const db = createPool(DATABASE_URL, 1);
  try {
    await migrate(db, undefined, process.argv.includes('--baseline'));
    console.log('migrate: schema current; provider quotas seeded');
  } finally {
    await db.end();
  }
}
