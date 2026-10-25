// pnpm seed [articles=20] [fault rate=0]
// Registers two mock WordPress sites, then posts the articles in bulk.
import { API, call } from './client.js';
import { ALL_FAULTS, brief, registerMockSite } from './fixtures.js';

const count = Number(process.argv[2] ?? 20);
const faults = { rate: Number(process.argv[3] ?? 0), kinds: ALL_FAULTS };

const sites = [await registerMockSite(faults), await registerMockSite(faults)];

for (const s of sites) {
  console.log(`site ${s.platform}: ${s.id}`);
}

const tag = Date.now().toString(36);

for (let start = 0; start < count; start += 1000) {
  const items = [];

  for (let n = start; n < Math.min(count, start + 1000); n++) {
    items.push({ site_id: sites[n % 2].id, brief: brief(n), idempotency_key: `seed-${tag}-${n}` });
  }

  await call('POST', `${API}/articles/bulk`, { items });
}

console.log(`posted ${count} articles; watch them with: curl -s ${API}/articles/summary`);
