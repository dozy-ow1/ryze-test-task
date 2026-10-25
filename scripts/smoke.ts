// pnpm smoke: publish ONE article on a real WordPress site and/or a real Shopify store with the real
// providers, from .env values alone. Before running it:
//   1. In .env set LLM_PROVIDER=anthropic + ANTHROPIC_API_KEY, IMAGE_PROVIDER=openai + OPENAI_API_KEY,
//      and WORDPRESS_URL / WORDPRESS_USER / WORDPRESS_APP_PASSWORD and/or SHOPIFY_STORE /
//      SHOPIFY_ACCESS_TOKEN / SHOPIFY_BLOG_ID.
//   2. docker compose up -d --wait   (the workers read the providers from .env at start)
// It prints the public URL and what the article cost (from operations.usage).
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseEnv } from 'node:util';
import { API, call } from './lib.js';

const env = parseEnv(readFileSync('.env', 'utf8')) as Record<string, string | undefined>;
const sites: { platform: 'wordpress' | 'shopify'; base_url: string; token: string }[] = [];
if (env.WORDPRESS_URL) {
  sites.push({
    platform: 'wordpress',
    base_url: `${env.WORDPRESS_URL.replace(/\/+$/, '')}/wp-json`,
    token: `${env.WORDPRESS_USER}:${env.WORDPRESS_APP_PASSWORD}`,
  });
}
if (env.SHOPIFY_STORE) {
  sites.push({
    platform: 'shopify',
    base_url: `https://${env.SHOPIFY_STORE}/admin/api/2026-10/blogs/${env.SHOPIFY_BLOG_ID}`,
    token: env.SHOPIFY_ACCESS_TOKEN ?? '',
  });
}
if (sites.length === 0) {
  console.error('smoke: set WORDPRESS_* and/or SHOPIFY_* in .env');
  process.exit(1);
}
if (env.LLM_PROVIDER !== 'anthropic' || env.IMAGE_PROVIDER !== 'openai') {
  console.warn('smoke: LLM_PROVIDER / IMAGE_PROVIDER in .env are not the real providers');
}

type Article = {
  article: { remote_url: string | null; published_at: string | null };
  operations: { step: string; status: string; last_error: string | null }[];
};

let ok = true;
for (const s of sites) {
  const site = await call<{ id: string }>('POST', `${API}/sites`, s);
  const created = await call<{ article_id: string }>('POST', `${API}/articles`, {
    site_id: site.body.id,
    brief: 'How to keep a basil plant alive on a kitchen windowsill',
    idempotency_key: `smoke-${Date.now()}`,
  });
  const id = created.body.article_id;
  console.log(`${s.platform}: article ${id} posted, waiting for it to go live ...`);
  const deadline = Date.now() + 10 * 60_000;
  let state: Article;
  for (;;) {
    state = (await call<Article>('GET', `${API}/articles/${id}`)).body;
    const stuck = state.operations.find((o) => o.status === 'failed' || o.status === 'unknown');
    if (state.article.published_at || stuck || Date.now() > deadline) break;
    await sleep(5_000);
  }
  const cost = execSync(
    `docker compose exec -T postgres psql -U ryze -d ryze -tAc "SELECT COALESCE(sum((usage ->> 'cost_usd')::numeric), 0) FROM operations WHERE article_id = '${id}'"`,
    { encoding: 'utf8' },
  ).trim();
  if (state.article.published_at) {
    console.log(`${s.platform}: live at ${state.article.remote_url} (cost $${cost})`);
  } else {
    ok = false;
    const last = state.operations.at(-1);
    console.error(
      `${s.platform}: not published: ${last?.step} ${last?.status} ${last?.last_error ?? ''}`,
    );
  }
}
process.exit(ok ? 0 : 1);
