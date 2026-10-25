import { parseArgs } from 'node:util';
import { createLogger, createPool, loadConfig, workerConfig } from '@ryze/core';
import pLimit from 'p-limit';
import { createClients } from './clients.js';
import { type PoolName, runPool } from './runner.js';
import { imageFetch } from './steps/image_fetch.js';
import { imageSubmit } from './steps/image_submit.js';
import { stubSteps } from './steps/stub.js';
import { text } from './steps/text.js';

// One binary: --pool=generate|publish runs a step pool; --mode=reconcile runs the reconciler once.
const { values } = parseArgs({ options: { pool: { type: 'string' }, mode: { type: 'string' } } });
const config = loadConfig(workerConfig);
const log = createLogger('worker', config.LOG_LEVEL);

const pool = values.pool ?? config.POOL;
if (pool !== 'generate' && pool !== 'publish') {
  console.error('worker: pass --pool=generate|publish (or set POOL)');
  process.exit(1);
}
const name: PoolName = pool;
const concurrency = config.CONCURRENCY ?? (name === 'generate' ? 8 : 16);
const leaseSeconds = config.LEASE_SECONDS ?? (name === 'generate' ? 120 : 60);
const db = createPool(config.DATABASE_URL, concurrency + 4);

const stop = new AbortController();
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    log.info({ signal }, 'stop claiming');
    stop.abort();
  });
}

log.info({ pool: name, concurrency, lease_seconds: leaseSeconds }, 'worker started');
await runPool(
  {
    db,
    log: log.child({ pool: name }),
    // verify, upload, draft and publish need the platform adapters (milestone 5).
    steps: { ...stubSteps, text, image_submit: imageSubmit, image_fetch: imageFetch },
    clients: createClients(config, db),
    siteTokenKey: config.SITE_TOKEN_KEY,
    leaseSeconds,
    maxAttempts: config.MAX_ATTEMPTS,
    imageKind: 'async', // the fake image provider is asynchronous
    imageLimit: pLimit(config.IMAGE_CONCURRENCY),
  },
  name,
  concurrency,
  stop.signal,
);
await db.end();
log.info('worker stopped');
process.exit(0);
