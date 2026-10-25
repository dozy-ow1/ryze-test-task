#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { loadConfig } from '../utils/config.js';
import { createPool } from './client.js';
import { migrate } from './migrations.js';

const { values } = parseArgs({ options: { baseline: { type: 'boolean', default: false } } });
const { DATABASE_URL } = loadConfig(z.object({ DATABASE_URL: z.url() }));
const db = createPool(DATABASE_URL, 1);

try {
  await migrate(db, undefined, values.baseline);
  console.log('migrate: schema current; provider quotas seeded');
} finally {
  await db.end();
}
