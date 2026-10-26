import { Permanent } from '../../utils/errors.js';
import { getJson, type Http, HttpError } from '../../utils/http.js';
import type { Site } from '../types.js';
import { isShopifyUrl, SHOPIFY_API_VERSION, shopifyCredentials } from './config.js';

interface GraphqlResponse<T> {
  data?: T;
  errors?: { message: string; extensions?: { code?: string } }[];
}

export interface UserError {
  code?: string;
  field?: string[];
  message: string;
}

export function checkUserErrors(errors: UserError[]): void {
  if (errors.length) {
    throw new Permanent(
      `Shopify rejected request: ${errors.map((error) => error.code ?? error.field?.join('.') ?? 'INVALID_INPUT').join(', ')}`,
    );
  }
}

export function credentials(site: Site) {
  try {
    return shopifyCredentials.parse(JSON.parse(site.token));
  } catch {
    throw new Permanent('Shopify credentials must contain clientId, clientSecret and blogId');
  }
}

export function createShopifyClient(http: Http) {
  // One cache entry per site. Credential changes invalidate the entry without retaining old secrets.
  const tokens = new Map<string, { credentials: string; token: string; expires: number }>();

  async function accessToken(site: Site, signal?: AbortSignal): Promise<string> {
    if (!isShopifyUrl(site.base_url)) {
      throw new Permanent('Shopify requires an HTTPS *.myshopify.com store root');
    }

    const cached = tokens.get(site.id);

    if (cached?.credentials === site.token && cached.expires > Date.now() + 60_000) {
      return cached.token;
    }

    const config = credentials(site);
    let response: { access_token: string; expires_in: number };

    try {
      response = await getJson(
        http,
        `${site.base_url.replace(/\/$/, '')}/admin/oauth/access_token`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'client_credentials',
            client_id: config.clientId,
            client_secret: config.clientSecret,
          }).toString(),
          signal,
        },
      );
    } catch (error) {
      if (error instanceof HttpError) {
        throw new HttpError(
          error.status,
          `Shopify token request failed (HTTP ${error.status}); check credentials, installation and organization`,
          error.retryAfter,
        );
      }

      throw error;
    }

    if (!response.access_token || !(response.expires_in > 0)) {
      throw new Permanent('Shopify returned an invalid token response');
    }

    tokens.set(site.id, {
      credentials: site.token,
      token: response.access_token,
      expires: Date.now() + response.expires_in * 1000,
    });

    return response.access_token;
  }

  return async function graphql<T>(
    site: Site,
    query: string,
    variables: Record<string, unknown> = {},
    signal?: AbortSignal,
  ): Promise<T> {
    const token = await accessToken(site, signal);

    let response: GraphqlResponse<T>;

    try {
      response = await getJson<GraphqlResponse<T>>(
        http,
        `${site.base_url.replace(/\/$/, '')}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
        {
          method: 'POST',
          headers: { 'X-Shopify-Access-Token': token },
          json: { query, variables },
          signal,
        },
      );
    } catch (error) {
      if (error instanceof HttpError && error.status === 401) {
        tokens.delete(site.id);

        // The next queue attempt obtains a fresh token; never replay a mutation here.
        throw new HttpError(503, 'Shopify token expired; retry with fresh credentials');
      }

      throw error;
    }

    if (response.errors?.length) {
      const codes = response.errors.map((error) => error.extensions?.code ?? 'GRAPHQL_ERROR');

      if (codes.includes('THROTTLED') || codes.includes('INTERNAL_SERVER_ERROR')) {
        throw new HttpError(
          codes.includes('THROTTLED') ? 429 : 503,
          `Shopify: ${codes.join(', ')}`,
          2,
        );
      }

      if (codes.includes('ACCESS_DENIED')) {
        throw new HttpError(403, 'Shopify: missing access scope');
      }

      throw new Permanent(`Shopify: ${codes.join(', ')}`);
    }

    if (!response.data) {
      throw new HttpError(503, 'Shopify returned no GraphQL data');
    }

    return response.data;
  };
}
