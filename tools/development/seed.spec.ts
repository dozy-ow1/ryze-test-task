import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const script = resolve('tools/development/seed.ts');

describe('seed command guard', () => {
  it('rejects unbounded input and real providers before any request is sent', () => {
    const unlimited = spawnSync(process.execPath, ['--import', 'tsx', script, 'Infinity'], {
      encoding: 'utf8',
    });
    expect(unlimited.status).not.toBe(0);
    expect(unlimited.stderr).toContain('article count from 1 to 1000');
    const paid = spawnSync(process.execPath, ['--import', 'tsx', script, '1'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        LLM_PROVIDER: 'anthropic',
        IMAGE_PROVIDER: 'mock',
        SHOPIFY_MODE: 'mock',
      },
    });
    expect(paid.status).not.toBe(0);
    expect(paid.stderr).toContain('seed requires LLM_PROVIDER=mock');
  });
});
