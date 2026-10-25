import { copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type TestDb, testDb } from '../test/support/database.js';
import { migrate } from './migrate.js';

let database: TestDb;
let directory: string;

beforeEach(async () => {
  database = await testDb();
  directory = await mkdtemp(join(tmpdir(), 'ryze-migrations-'));
  await copyFile('db/migrations/001-initial.sql', join(directory, '001-initial.sql'));
});
afterEach(async () => {
  await database?.drop();
  if (directory) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe('migrations', () => {
  it('requires explicit baselining for an unversioned existing database', async () => {
    await expect(migrate(database.db, directory)).rejects.toThrow('Unversioned database');
    await migrate(database.db, directory, true);
    await migrate(database.db, directory);
    expect((await database.db.query('SELECT count(*) AS n FROM schema_migrations')).rows[0].n).toBe(
      1,
    );
  });

  it('applies migrations once under concurrent deploys and rejects changed history', async () => {
    await database.db.query('DROP TABLE operations, articles, sites, quotas, batches CASCADE');
    await writeFile(
      join(directory, '002-review.sql'),
      'ALTER TABLE sites ADD COLUMN reviewed boolean DEFAULT false;',
    );
    await Promise.all([migrate(database.db, directory), migrate(database.db, directory)]);
    expect((await database.db.query('SELECT count(*) AS n FROM schema_migrations')).rows[0].n).toBe(
      2,
    );
    await writeFile(
      join(directory, '002-review.sql'),
      'ALTER TABLE sites ADD COLUMN other boolean;',
    );
    await expect(migrate(database.db, directory)).rejects.toThrow('Applied migration changed');
  });

  it('rolls back the entire migration batch when a statement fails', async () => {
    await database.db.query('DROP TABLE operations, articles, sites, quotas, batches CASCADE');
    await writeFile(join(directory, '002-broken.sql'), 'SELECT missing_column FROM sites;');
    await expect(migrate(database.db, directory)).rejects.toThrow();
    const { rows } = await database.db.query(
      "SELECT to_regclass('operations') AS operations, to_regclass('schema_migrations') AS migrations",
    );
    expect(rows[0]).toEqual({ operations: null, migrations: null });
  });
});
