import { randomUUID } from 'node:crypto';
import { Deferred, Permanent } from '../../utils/errors.js';
import { type Http, HttpError } from '../../utils/http.js';
import type { Site } from '../types.js';
import { checkUserErrors, type createShopifyClient, type UserError } from './client.js';

type Graphql = ReturnType<typeof createShopifyClient>;
interface ImageFile {
  id: string;
  fileStatus: string;
  createdAt: string;
  image?: { url: string } | null;
}

const FILE_FIELDS = 'id createdAt fileStatus ... on MediaImage { image { url } }';

export function createShopifyMedia(http: Http, graphql: Graphql) {
  return {
    async findMedia(site: Site, filename: string, signal?: AbortSignal) {
      const data = await graphql<{ files: { nodes: (ImageFile & { alt?: string })[] } }>(
        site,
        `query FindCover($query: String!) { files(first: 10, query: $query) { nodes { ${FILE_FIELDS} alt } } }`,
        { query: `filename:${filename}` },
        signal,
      );

      // Shopify's filename search can be fuzzy; the exact alt marker identifies our upload.
      const file = data.files.nodes.find((item) => item.alt === filename);

      if (file?.fileStatus === 'FAILED') {
        throw new Permanent('Shopify cover processing failed');
      }

      return file?.id ?? null;
    },

    async uploadMedia(site: Site, filename: string, bytes: Buffer, signal?: AbortSignal) {
      const staged = await graphql<{
        stagedUploadsCreate: {
          stagedTargets: {
            url: string;
            resourceUrl: string;
            parameters: { name: string; value: string }[];
          }[];
          userErrors: UserError[];
        };
      }>(
        site,
        `mutation StageCover($input: [StagedUploadInput!]!) { stagedUploadsCreate(input: $input) { stagedTargets { url resourceUrl parameters { name value } } userErrors { field message } } }`,
        { input: [{ filename, mimeType: 'image/jpeg', resource: 'IMAGE', httpMethod: 'POST' }] },
        signal,
      );
      checkUserErrors(staged.stagedUploadsCreate.userErrors);
      const target = staged.stagedUploadsCreate.stagedTargets[0];

      if (!target) {
        throw new Permanent('Shopify returned no upload target');
      }

      const boundary = `ryze-${randomUUID()}`;

      const fields = target.parameters.map(({ name, value }) =>
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
        ),
      );

      const body = Buffer.concat([
        ...fields,
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: image/jpeg\r\n\r\n`,
        ),
        bytes,
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]);

      signal?.throwIfAborted();
      await http(target.url, {
        method: 'POST',
        headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
        body,
        signal,
      });
      signal?.throwIfAborted();

      const created = await graphql<{
        fileCreate: { files: ImageFile[]; userErrors: UserError[] };
      }>(
        site,
        `mutation SaveCover($files: [FileCreateInput!]!) { fileCreate(files: $files) { files { ${FILE_FIELDS} } userErrors { code field message } } }`,
        {
          files: [
            {
              originalSource: target.resourceUrl,
              filename,
              alt: filename,
              contentType: 'IMAGE',
              duplicateResolutionMode: 'RAISE_ERROR',
            },
          ],
        },
        signal,
      );

      if (created.fileCreate.userErrors.length) {
        // A lost fileCreate response may leave an existing file whose search index is not ready.
        // Re-run the lookup through the queue instead of creating a renamed duplicate.
        if (
          created.fileCreate.userErrors.some((error) => error.code === 'FILENAME_ALREADY_EXISTS')
        ) {
          throw new HttpError(503, 'Waiting for existing Shopify cover to appear in search');
        }

        checkUserErrors(created.fileCreate.userErrors);
      }

      const file = created.fileCreate.files[0];

      if (!file || file.fileStatus === 'FAILED') {
        throw new Permanent('Shopify failed to create the cover');
      }

      return file.id;
    },

    async imageUrl(site: Site, id: string, signal?: AbortSignal) {
      const data = await graphql<{ node: ImageFile | null }>(
        site,
        `query CoverStatus($id: ID!) { node(id: $id) { ... on MediaImage { id createdAt fileStatus image { url } } } }`,
        { id },
        signal,
      );

      const file = data.node;

      if (!file || file.fileStatus === 'FAILED') {
        throw new Permanent('Shopify cover is missing or failed');
      }

      if (file.fileStatus !== 'READY' || !file.image?.url) {
        if (
          !Number.isFinite(Date.parse(file.createdAt)) ||
          Date.now() - Date.parse(file.createdAt) > 10 * 60_000
        ) {
          throw new Permanent('Shopify cover processing exceeded ten minutes');
        }

        throw new Deferred(new Date(Date.now() + 5000), 'Waiting for Shopify cover processing');
      }

      return file.image.url;
    },
  };
}
