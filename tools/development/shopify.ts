// Read-only setup check: validates credentials/scopes and lists blogs. Does not publish content.
import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { createHttp, HttpError, normalizeShopifyShop, SHOPIFY_API_VERSION, SHOPIFY_SCOPES } from '@ryze/shared';

const env = {
  ...(existsSync('.env') ? parseEnv(readFileSync('.env', 'utf8')) : {}),
  ...process.env,
};

const shop = normalizeShopifyShop(env.SHOPIFY_SHOP ?? '');
const clientId = env.SHOPIFY_CLIENT_ID;
const clientSecret = env.SHOPIFY_CLIENT_SECRET;

const missing = ['SHOPIFY_SHOP', 'SHOPIFY_CLIENT_ID', 'SHOPIFY_CLIENT_SECRET'].filter(
  (key) => !env[key]?.trim(),
);

if (missing.length) {
  console.error(`Missing configuration: ${missing.join(', ')}. Set these in .env or process.env.`);
  process.exit(1);
}

if (!shop) {
  console.error(
    'SHOPIFY_SHOP must be store.myshopify.com or https://store.myshopify.com/; do not use the admin URL or a custom domain.',
  );
  process.exit(1);
}

const http = createHttp(30_000);

try {
  const tokenResponse = await http(`https://${shop}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId as string,
      client_secret: clientSecret as string,
    }).toString(),
  });

  const token = JSON.parse(tokenResponse.body.toString()) as { access_token: string };

  const response = await http(`https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: { 'X-Shopify-Access-Token': token.access_token },
    json: {
      query: 'query PublisherSetup { currentAppInstallation { accessScopes { handle } } }',
    },
  });

  const result = JSON.parse(response.body.toString()) as {
    errors?: { extensions?: { code?: string } }[];
    data?: {
      currentAppInstallation: { accessScopes: { handle: string }[] };
    };
  };

  if (result.errors?.length || !result.data) {
    throw new Error(
      `Shopify setup query failed: ${result.errors?.map((error) => error.extensions?.code ?? 'GRAPHQL_ERROR').join(', ')}`,
    );
  }

  const scopes = result.data.currentAppInstallation.accessScopes.map((scope) => scope.handle);
  const missing = SHOPIFY_SCOPES.filter((scope) => !scopes.includes(scope));
  console.log(`Store: ${shop}`);
  console.log(`Granted scopes: ${scopes.join(', ')}`);

  if (missing.length) {
    console.error(
      `Add scopes, release a version and approve them on the store: ${missing.join(', ')}`,
    );
    process.exit(1);
  }

  const blogsResponse = await http(
    `https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
    {
      method: 'POST',
      headers: { 'X-Shopify-Access-Token': token.access_token },
      json: {
        query:
          'query PublisherBlogs { blogs(first: 50) { nodes { id title handle } pageInfo { hasNextPage } } }',
      },
    },
  );

  const blogsResult = JSON.parse(blogsResponse.body.toString()) as {
    errors?: { extensions?: { code?: string } }[];
    data?: {
      blogs: {
        nodes: { id: string; title: string; handle: string }[];
        pageInfo: { hasNextPage: boolean };
      };
    };
  };

  if (blogsResult.errors?.length || !blogsResult.data) {
    throw new Error(
      `Shopify blog query failed: ${blogsResult.errors?.map((error) => error.extensions?.code ?? 'GRAPHQL_ERROR').join(', ')}`,
    );
  }

  const blogs = blogsResult.data.blogs;
  console.table(blogs.nodes);

  if (blogs.nodes.length === 0) {
    console.error('Create a blog in Shopify before submitting articles.');
    process.exitCode = 1;
  } else {
    console.log('Set SHOPIFY_BLOG_ID in .env to the chosen gid://shopify/Blog/... value above.');
  }

  if (blogs.pageInfo.hasNextPage) {
    console.log('Showing the first 50 blogs.');
  }
} catch (error) {
  // Never print upstream response bodies or credentials during setup.
  console.error(
    error instanceof HttpError
      ? `Shopify setup failed (HTTP ${error.status}). Check the store, installation, organization and credentials.`
      : error instanceof Error
        ? error.message
        : 'Shopify setup failed',
  );
  process.exitCode = 1;
}
