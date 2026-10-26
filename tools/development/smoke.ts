// Publishes one article to the configured Shopify blog. This command writes publicly visible content.
import { readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseEnv } from 'node:util';
import { normalizeShopifyShop } from '@ryze/core';
import { API, call } from './client.js';

const env = { ...parseEnv(readFileSync('.env', 'utf8')), ...process.env };
const shop = normalizeShopifyShop(env.SHOPIFY_SHOP ?? '');

if (!shop || !env.SHOPIFY_CLIENT_ID || !env.SHOPIFY_CLIENT_SECRET || !env.SHOPIFY_BLOG_ID) {
  throw new Error(
    'Configure SHOPIFY_SHOP, SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET and SHOPIFY_BLOG_ID; run pnpm shopify:check first',
  );
}

const destination = {
  platform: 'shopify',
  base_url: `https://${shop}`,
  token: JSON.stringify({
    clientId: env.SHOPIFY_CLIENT_ID,
    clientSecret: env.SHOPIFY_CLIENT_SECRET,
    blogId: env.SHOPIFY_BLOG_ID,
  }),
};

console.log(
  `smoke: text=${env.LLM_PROVIDER ?? 'mock'}, images=${env.IMAGE_PROVIDER ?? 'mock'}; publishes one article to the configured Shopify blog`,
);

type Article = {
  article: { remote_url: string | null; published_at: string | null };
  operations: {
    step: string;
    status: string;
    last_error: string | null;
    usage: { cost_usd: number | null } | null;
  }[];
};

const site = await call<{ id: string }>('POST', `${API}/sites`, destination);

const created = await call<{ article_id: string }>('POST', `${API}/articles`, {
  site_id: site.body.id,
  brief: 'How to keep a basil plant alive on a kitchen windowsill',
  idempotency_key: `smoke-${Date.now()}`,
});

const id = created.body.article_id;
console.log(`shopify: article ${id} posted, waiting for it to go live ...`);
const deadline = Date.now() + 10 * 60_000;
let state: Article;

for (;;) {
  state = (await call<Article>('GET', `${API}/articles/${id}`)).body;
  const stuck = state.operations.find((o) => o.status === 'failed' || o.status === 'unknown');

  if (state.article.published_at || stuck || Date.now() > deadline) {
    break;
  }

  await sleep(5_000);
}

const usage = state.operations.flatMap((operation) => (operation.usage ? [operation.usage] : []));
const cost = usage.reduce((sum, entry) => sum + (entry.cost_usd ?? 0), 0);
const unknown = usage.filter((entry) => entry.cost_usd === null).length;

if (state.article.published_at) {
  console.log(
    `shopify: live at ${state.article.remote_url} (recorded cost $${cost.toFixed(6)}; ${unknown} operations with unknown cost)`,
  );
} else {
  process.exitCode = 1;
  const last = state.operations.at(-1);
  console.error(`shopify: not published: ${last?.step} ${last?.status} ${last?.last_error ?? ''}`);
}
