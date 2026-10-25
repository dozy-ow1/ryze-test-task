import { randomBytes } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPool, type Database } from '@ryze/core';

const directory = fileURLToPath(new URL('../migrations', import.meta.url));

const schemaSql = readdirSync(directory)
  .filter((file) => file.endsWith('.sql'))
  .sort()
  .map((file) => readFileSync(join(directory, file), 'utf8'))
  .join('\n');

export interface TestDb {
  db: Database;
  url: string; // connection string bound to the throwaway schema
  drop(): Promise<void>;
}

// A fresh copy of the core migrations in its own Postgres schema on the Compose database, so test files
// run in parallel without touching each other or the demo's tables.
export async function testDb(): Promise<TestDb> {
  const base = process.env.TEST_DATABASE_URL as string;
  const name = `t_${randomBytes(4).toString('hex')}`;
  const admin = createPool(base, 1);
  await admin.query(`CREATE SCHEMA ${name}`);
  await admin.end();
  const scoped = new URL(base);
  const options = scoped.searchParams.get('options');
  scoped.searchParams.set('options', `${options ? `${options} ` : ''}-c search_path=${name}`);
  const url = scoped.toString();
  const db = createPool(url, 20);
  await db.query(schemaSql);

  return {
    db,
    url,

    async drop() {
      await db.end();
      const cleanup = createPool(base, 1);
      await cleanup.query(`DROP SCHEMA ${name} CASCADE`);
      await cleanup.end();
    },
  };
}
