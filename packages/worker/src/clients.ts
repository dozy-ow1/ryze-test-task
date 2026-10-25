import {
  anthropicLlm,
  createHttp,
  type Db,
  fakeImage,
  fakeLlm,
  type Http,
  type ImageProvider,
  type LlmProvider,
  openaiImage,
  type PlatformAdapter,
  SQL,
  shopify,
  type WorkerConfig,
  wordpress,
} from '@ryze/core';
import { type Store, s3Store } from './store.js';

// Everything a step talks to. Which provider runs is configuration, never code.
export interface Clients {
  db: Db;
  http: Http;
  llm: LlmProvider;
  image: ImageProvider;
  store: Store;
  adapters: Record<'wordpress' | 'shopify', PlatformAdapter>;
}

// Real generation can outlast HTTP_TIMEOUT_MS, and a call the client gives up on is still billed:
// the real providers get a longer deadline (still well inside the generate pool's lease renewals).
const GENERATION_TIMEOUT_MS = 120_000;

export function createClients(config: WorkerConfig, db: Db): Clients {
  const http = createHttp(config.HTTP_TIMEOUT_MS);
  const generationTimeout = Math.max(config.HTTP_TIMEOUT_MS, GENERATION_TIMEOUT_MS);
  const llm =
    config.LLM_PROVIDER === 'anthropic'
      ? anthropicLlm({
          apiKey: config.ANTHROPIC_API_KEY as string,
          model: config.ANTHROPIC_MODEL,
          timeoutMs: generationTimeout,
        })
      : fakeLlm(http, config.LLM_BASE_URL as string);
  const image =
    config.IMAGE_PROVIDER === 'openai'
      ? openaiImage(createHttp(generationTimeout), {
          apiKey: config.OPENAI_API_KEY as string,
          model: config.OPENAI_IMAGE_MODEL,
        })
      : fakeImage(http, config.IMAGE_BASE_URL as string);
  // A real Shopify store reports its bucket on every answer; keep the site's quota row in line.
  const followShopify = async (site: { id: string }, available: number) => {
    await db.query(SQL.QUOTA_SET, [`site:${site.id}`, available]);
  };
  return {
    db,
    http,
    llm,
    image,
    store: s3Store(config),
    adapters: { wordpress: wordpress(http), shopify: shopify(http, followShopify) },
  };
}
