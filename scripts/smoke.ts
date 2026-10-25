// Publishes one article to the configured real WordPress site using real generation providers.
import { readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseEnv } from 'node:util';
import { API, call } from './lib.js';

const env = parseEnv(readFileSync('.env', 'utf8')) as Record<string, string | undefined>;
const sites: { platform: 'wordpress'; base_url: string; token: string }[] = [];

if (env.WORDPRESS_URL) {
  sites.push({
    platform: 'wordpress',
    base_url: `${env.WORDPRESS_URL.replace(/\/+$/, '')}/wp-json`,
    token: `${env.WORDPRESS_USER}:${env.WORDPRESS_APP_PASSWORD}`,
  });
}

if (sites.length === 0) {
  console.error('smoke: set WORDPRESS_URL, WORDPRESS_USER and WORDPRESS_APP_PASSWORD in .env');
  process.exit(1);
}

if (env.LLM_PROVIDER !== 'anthropic' || env.IMAGE_PROVIDER !== 'openai') {
  console.warn('smoke: LLM_PROVIDER / IMAGE_PROVIDER in .env are not the real providers');
}

type Article = {
  article: { remote_url: string | null; published_at: string | null };
  operations: {
    step: string;
    status: string;
    last_error: string | null;
    usage: { cost_usd: number | null } | null;
  }[];
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
      `${s.platform}: live at ${state.article.remote_url} (recorded cost $${cost.toFixed(6)}; ${unknown} operations with unknown cost)`,
    );
  } else {
    ok = false;
    const last = state.operations.at(-1);
    console.error(
      `${s.platform}: not published: ${last?.step} ${last?.status} ${last?.last_error ?? ''}`,
    );
  }
}

process.exit(ok ? 0 : 1);
