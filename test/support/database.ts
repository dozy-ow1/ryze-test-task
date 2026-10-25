import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createPool, type Database } from '@ryze/core';

const schemaSql = readFileSync('db/migrations/001-initial.sql', 'utf8');

export interface TestDb {
  db: Database;
  url: string; // connection string bound to the throwaway schema
  drop(): Promise<void>;
}

// A fresh copy of db/migrations/001-initial.sql in its own Postgres schema on the Compose database, so test files
// run in parallel without touching each other or the demo's tables.
export async function testDb(): Promise<TestDb> {
  const base = process.env.TEST_DATABASE_URL as string;
  const name = `t_${randomBytes(4).toString('hex')}`;
  const admin = createPool(base, 1);
  await admin.query(`CREATE SCHEMA ${name}`);
  await admin.end();
  const url = `${base}?options=${encodeURIComponent(`-c search_path=${name}`)}`;
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
