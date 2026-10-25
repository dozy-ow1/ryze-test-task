import { getJson, type Http } from '../adapters/http.js';

// Identical for the fake and the real provider. An async provider takes a job and is polled for
// it; a sync one returns the image from one call (the pipeline then has no image_submit step).
export interface ImageProvider {
  kind: 'async' | 'sync';
  submit?(prompt: string): Promise<{ jobId: string }>;
  poll?(jobId: string): Promise<{ status: 'pending' | 'done'; url?: string }>;
  generate?(prompt: string): Promise<Buffer>;
}

// The emulator in packages/fake-providers: asynchronous jobs, so the job-id recovery path runs.
export function fakeImage(http: Http, baseUrl: string): ImageProvider {
  return {
    kind: 'async',
    async submit(prompt) {
      const r = await getJson<{ job_id: string }>(http, `${baseUrl}/v1/images`, {
        method: 'POST',
        json: { prompt },
      });
      return { jobId: r.job_id };
    },
    async poll(jobId) {
      const r = await getJson<{ status: 'pending' | 'done'; url?: string }>(
        http,
        `${baseUrl}/v1/images/${encodeURIComponent(jobId)}`,
      );
      return { status: r.status, url: r.url && new URL(r.url, baseUrl).toString() };
    },
  };
}
