import { createAnthropic, createHttp, createMockImage, createMockText, createOpenAI, createShopify, type Database, type Http, type ImageProvider, type PlatformAdapter, type TextProvider } from '@ryze/shared';
import type { ReconcileConfig, WorkerConfig } from '../config.js';
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
    allowedHosts: [
      ...(config.LLM_PROVIDER === 'mock' || config.IMAGE_PROVIDER === 'mock'
        ? ['mock-providers']
        : []),
      ...(config.SHOPIFY_MODE === 'mock' ? ['mock-shopify'] : []),
    ],
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
    platform: createPlatformClients(config, http).platform,
  };
}

// Reconciliation needs only transport and platform credentials, not generation providers or S3.
export function createPlatformClients(
  config: ReconcileConfig,
  http = createHttp(HTTP_TIMEOUT_MS, {
    allowedHosts: config.SHOPIFY_MODE === 'mock' ? ['mock-shopify'] : [],
  }),
) {
  // Mock mode swaps only the Shopify transport; the adapter and its credentials stay identical.
  const shopifyHttp: Http =
    config.SHOPIFY_MODE === 'mock'
      ? (url, request) => {
          const parsed = new URL(url);

          const destination = parsed.hostname.endsWith('.myshopify.com')
            ? `${config.MOCK_SHOPIFY_URL}${parsed.pathname}${parsed.search}`
            : url;

          return http(destination, request);
        }
      : http;

  return { http, platform: createShopify(shopifyHttp) };
}
