import { parseArgs } from 'node:util';
import { createLogger, createPool, loadConfig, workerConfig } from '@ryze/core';
import pLimit from 'p-limit';
import { createClients } from './clients.js';
import { reconcile } from './reconcile.js';
import { type PoolName, runPool } from './runner.js';
import { IMAGE_CONCURRENCY, MAX_ATTEMPTS, POOL_LIMITS } from './settings.js';
import { draft } from './steps/draft.js';
import { imageFetch } from './steps/image-fetch.js';
import { imageSubmit } from './steps/image-submit.js';
import { publish } from './steps/publish.js';
import { text } from './steps/text.js';
import { upload } from './steps/upload.js';
import { verify } from './steps/verify.js';

// One binary: --pool=generate|publish runs a step pool; --mode=reconcile runs the reconciler once.
const { values } = parseArgs({ options: { pool: { type: 'string' }, mode: { type: 'string' } } });
const config = loadConfig(workerConfig);
const log = createLogger('worker', config.LOG_LEVEL);

if (values.mode === 'reconcile') {
  const db = createPool(config.DATABASE_URL, 2);
  const report = await reconcile({
    db,
    clients: createClients(config, db),
    log: log.child({ mode: 'reconcile' }),
    siteTokenKey: config.SITE_TOKEN_KEY,
    fakePlatformsUrl: config.FAKE_PLATFORMS_URL,
  });
  console.log(JSON.stringify(report));
  await db.end();
  process.exit(0);
}

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
