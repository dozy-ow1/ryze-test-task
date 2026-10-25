import { createPool, loadConfig } from '@ryze/core';
import { buildApp } from './app.js';
import { apiConfig } from './config.js';

const config = loadConfig(apiConfig);
const db = createPool(config.DATABASE_URL, 10);
const app = buildApp({ db, siteTokenKey: config.SITE_TOKEN_KEY, logLevel: config.LOG_LEVEL });

// SIGTERM: stop accepting, let in-flight requests finish, close the pool.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, async () => {
    app.log.info({ signal }, 'shutting down');
    await app.close();
    await db.end();
    process.exit(0);
  });
}

await app.listen({ host: '0.0.0.0', port: config.PORT });
