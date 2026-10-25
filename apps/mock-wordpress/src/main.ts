import { loadConfig, mockConfig } from '@ryze/core';
import { buildApp } from './app.js';

const config = loadConfig(mockConfig, { PORT: '8092', ...process.env });

const app = buildApp({
  faultRate: config.FAULT_RATE,
  faultKinds: config.FAULT_KINDS,
  logLevel: config.LOG_LEVEL,
});

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, async () => {
    await app.close();
    process.exit(0);
  });
}

await app.listen({ port: config.PORT, host: '0.0.0.0' });
