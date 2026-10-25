import { parseArgs } from 'node:util';
import { createLogger, createPool, loadConfig } from '@ryze/core';
import pLimit from 'p-limit';
import { workerConfig } from './config.js';
import { createClients } from './infrastructure/clients.js';
import { imageFetch } from './modules/generation/image-fetch.js';
import { imageSubmit } from './modules/generation/image-submit.js';
import { text } from './modules/generation/text.js';
import { verify } from './modules/generation/verify.js';
import { draft } from './modules/publishing/draft.js';
import { publish } from './modules/publishing/publish.js';
import { upload } from './modules/publishing/upload.js';
import { runPool } from './runtime/pool.js';
import type { PoolName } from './runtime/workflow.js';
import { IMAGE_CONCURRENCY, MAX_ATTEMPTS, POOL_LIMITS } from './settings.js';

// Each process runs one pool; reconciliation has its own entrypoint.
const { values } = parseArgs({ options: { pool: { type: 'string' } } });
const config = loadConfig(workerConfig);
const log = createLogger('worker', config.LOG_LEVEL);

const pool = values.pool;

if (pool !== 'generate' && pool !== 'publish') {
  console.error('worker: pass --pool=generate|publish');
  process.exit(1);
}

const name: PoolName = pool;
const { concurrency, leaseSeconds } = POOL_LIMITS[name];
const db = createPool(config.DATABASE_URL, concurrency + 4);

const stop = new AbortController();

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    log.info({ signal }, 'stop claiming');
    stop.abort();
  });
}

const clients = createClients(config, db);
log.info({ pool: name, concurrency, lease_seconds: leaseSeconds }, 'worker started');
await runPool(
  {
    db,
    log: log.child({ pool: name }),
    steps: {
      verify,
      text,
      image_submit: imageSubmit,
      image_fetch: imageFetch,
      upload,
      draft,
      publish,
    },
    clients,
    siteTokenKey: config.SITE_TOKEN_KEY,
    leaseSeconds,
    maxAttempts: MAX_ATTEMPTS,
    imageKind: clients.image.kind, // a sync provider has no image_submit step
    imageLimit: pLimit(IMAGE_CONCURRENCY),
  },
  name,
  concurrency,
  stop.signal,
);
await db.end();
log.info('worker stopped');
process.exit(0);
