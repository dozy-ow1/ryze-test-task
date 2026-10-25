import {
  createHttp,
  type Db,
  fakeImage,
  fakeLlm,
  type Http,
  type ImageProvider,
  type LlmProvider,
  type PlatformAdapter,
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

export function createClients(config: WorkerConfig, db: Db): Clients {
  const http = createHttp(config.HTTP_TIMEOUT_MS);
  return {
    db,
    http,
    llm: fakeLlm(http, config.LLM_BASE_URL as string),
    image: fakeImage(http, config.IMAGE_BASE_URL as string),
    store: s3Store(config),
    adapters: { wordpress: wordpress(http), shopify: shopify(http) },
  };
}
