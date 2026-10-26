import { createLogger, createPool, loadConfig } from '@ryze/core';
import { workerConfig } from './config.js';
import { createClients } from './infrastructure/clients.js';
import { reconcile } from './modules/reconciliation/reconcile.js';

// Run one reconciliation pass. The deployment schedules repeated passes.
const config = loadConfig(workerConfig);
const db = createPool(config.DATABASE_URL, 2);
const log = createLogger('reconciler', config.LOG_LEVEL);

try {
  const report = await reconcile({
    db,
    clients: createClients(config, db),
    log,
    siteTokenKey: config.SITE_TOKEN_KEY,
    mockShopifyUrl: config.SHOPIFY_MODE === 'mock' ? config.MOCK_SHOPIFY_URL : undefined,
  });
  console.log(JSON.stringify(report));
} finally {
  await db.end();
}

process.exit(0);
