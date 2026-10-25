import {
  createAnthropic,
  createFakeImage,
  createFakeText,
  createHttp,
  createOpenAI,
  createShopify,
  createWordPress,
  type Database,
  type Http,
  type ImageProvider,
  type PlatformAdapter,
  SQL,
  type TextProvider,
  type WorkerConfig,
} from '@ryze/core';
import { GENERATION_TIMEOUT_MS, HTTP_TIMEOUT_MS } from './settings.js';
import { type Store, s3Store } from './store.js';

// Everything a step talks to. Which provider runs is configuration, never code.
export interface Clients {
  db: Database;
  http: Http;
  llm: TextProvider;
  image: ImageProvider;
  store: Store;
  adapters: Record<'wordpress' | 'shopify', PlatformAdapter>;
}

export function createClients(config: WorkerConfig, db: Database): Clients {
  const http = createHttp(HTTP_TIMEOUT_MS, {
    allowedHosts: ['fake-providers', 'fake-platforms'],
  });
  const generationTimeout = GENERATION_TIMEOUT_MS;
  const llm =
    config.LLM_PROVIDER === 'anthropic'
      ? createAnthropic({
          apiKey: config.ANTHROPIC_API_KEY as string,
          model: config.ANTHROPIC_MODEL,
          timeoutMs: generationTimeout,
        })
      : createFakeText(http, config.LLM_BASE_URL as string);
  const image =
    config.IMAGE_PROVIDER === 'openai'
      ? createOpenAI(createHttp(generationTimeout), {
          apiKey: config.OPENAI_API_KEY as string,
          model: config.OPENAI_IMAGE_MODEL,
        })
      : createFakeImage(http, config.IMAGE_BASE_URL as string);
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
    adapters: { wordpress: createWordPress(http), shopify: createShopify(http, followShopify) },
  };
}
