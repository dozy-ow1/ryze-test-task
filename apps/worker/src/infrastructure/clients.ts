import { createAnthropic, createHttp, createMockImage, createMockText, createOpenAI, createWordPress, type Database, type Http, type ImageProvider, type PlatformAdapter, type TextProvider } from '@ryze/core';
import type { WorkerConfig } from '../config.js';
import { GENERATION_TIMEOUT_MS, HTTP_TIMEOUT_MS } from '../settings.js';
import { type Store, s3Store } from './store.js';

// Everything a step talks to. Which provider runs is configuration, never code.
export interface Clients {
  db: Database;
  http: Http;
  llm: TextProvider;
  image: ImageProvider;
  store: Store;
  platform: PlatformAdapter;
}

export function createClients(config: WorkerConfig, db: Database): Clients {
  const http = createHttp(HTTP_TIMEOUT_MS, {
    allowedHosts: ['mock-providers', 'mock-wordpress'],
  });

  const llm =
    config.LLM_PROVIDER === 'anthropic'
      ? createAnthropic({
          apiKey: config.ANTHROPIC_API_KEY as string,
          model: config.ANTHROPIC_MODEL,
          timeoutMs: GENERATION_TIMEOUT_MS,
        })
      : createMockText(http, config.LLM_BASE_URL as string);

  const image =
    config.IMAGE_PROVIDER === 'openai'
      ? createOpenAI(createHttp(GENERATION_TIMEOUT_MS), {
          apiKey: config.OPENAI_API_KEY as string,
          model: config.OPENAI_IMAGE_MODEL,
        })
      : createMockImage(http, config.IMAGE_BASE_URL as string);

  return {
    db,
    http,
    llm,
    image,
    store: s3Store(config),
    platform: createWordPress(http),
  };
}
