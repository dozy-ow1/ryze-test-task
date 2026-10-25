import { loadConfig, mockConfig } from '@ryze/core';
import { buildApp } from './app.js';

const config = loadConfig(mockConfig, { PORT: '8091', ...process.env });

const app = buildApp({
  faultRate: config.FAULT_RATE,
  faultKinds: config.FAULT_KINDS,
  logLevel: config.LOG_LEVEL,
});

await app.listen({ port: config.PORT, host: '0.0.0.0' });
app.log.info({ rate: config.FAULT_RATE, kinds: config.FAULT_KINDS }, 'fault injection');

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.once(signal, async () => {
    await app.close();
    process.exit(0);
  });
}
