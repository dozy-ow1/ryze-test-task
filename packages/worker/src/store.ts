import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import type { WorkerConfig } from '@ryze/core';
import { HTTP_TIMEOUT_MS } from './settings.js';

// The cover image lives at a key derived from the article id, so any attempt can find it.
export const coverKey = (articleId: string) => `articles/${articleId}/cover.jpg`;

export interface Store {
  exists(key: string, signal?: AbortSignal): Promise<boolean>;
  put(key: string, bytes: Buffer, signal?: AbortSignal): Promise<void>;
  get(key: string, signal?: AbortSignal): Promise<Buffer>;
}

export function s3Store(config: WorkerConfig): Store {
  const s3 = new S3Client({
    endpoint: config.S3_ENDPOINT,
    region: 'us-east-1',
    forcePathStyle: true, // MinIO
    credentials: { accessKeyId: config.S3_ACCESS_KEY, secretAccessKey: config.S3_SECRET_KEY },
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
    // Without a deadline a hung call would hold its operation forever (the lease keeps renewing).
    requestHandler: { connectionTimeout: 5_000, requestTimeout: HTTP_TIMEOUT_MS },
  });
  const Bucket = config.S3_BUCKET;
  return {
    async exists(key, signal) {
      try {
        await s3.send(new HeadObjectCommand({ Bucket, Key: key }), { abortSignal: signal });
        return true;
      } catch (err) {
        if (
          (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404
        ) {
          return false;
        }
        throw err;
      }
    },
    async put(key, bytes, signal) {
      await s3.send(
        new PutObjectCommand({ Bucket, Key: key, Body: bytes, ContentType: 'image/jpeg' }),
        { abortSignal: signal },
      );
    },
    async get(key, signal) {
      const res = await s3.send(new GetObjectCommand({ Bucket, Key: key }), {
        abortSignal: signal,
      });
      if (!res.Body) {
        throw new Error(`empty object ${key}`);
      }
      return Buffer.from(await res.Body.transformToByteArray());
    },
  };
}
