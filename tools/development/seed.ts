// pnpm seed [articles=20] [fault rate=0]
// Registers two mock Shopify sites, then posts the articles in bulk.
import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { API, call } from './client.js';
import { ALL_FAULTS, brief, registerMockSite } from './fixtures.js';

const count = Number(process.argv[2] ?? 20);
const rate = Number(process.argv[3] ?? 0);

const env = {
  ...(existsSync('.env') ? parseEnv(readFileSync('.env', 'utf8')) : {}),
  ...process.env,
};

if (
  !Number.isInteger(count) ||
  count < 1 ||
  count > 1000 ||
  !Number.isFinite(rate) ||
  rate < 0 ||
  rate > 1
) {
  throw new Error('seed expects an article count from 1 to 1000 and a fault rate from 0 to 1');
}

if (
  (env.LLM_PROVIDER ?? 'mock') !== 'mock' ||
  (env.IMAGE_PROVIDER ?? 'mock') !== 'mock' ||
  env.SHOPIFY_MODE !== 'mock'
) {
  throw new Error(
    'seed requires LLM_PROVIDER=mock, IMAGE_PROVIDER=mock and SHOPIFY_MODE=mock; use pnpm demo for an isolated stack',
  );
}

const faults = { rate, kinds: ALL_FAULTS };

const sites = [await registerMockSite(faults), await registerMockSite(faults)];

for (const s of sites) {
  console.log(`site ${s.platform}: ${s.id}`);
}

const tag = Date.now().toString(36);

const items = Array.from({ length: count }, (_, n) => ({
  site_id: sites[n % sites.length].id,
  brief: brief(n),
  idempotency_key: `seed-${tag}-${n}`,
}));
await call('POST', `${API}/articles/bulk`, { items });

console.log(`posted ${count} articles; watch them with: curl -s ${API}/articles/summary`);
