import { getJson, type Http } from '../platforms/http.js';
import type { ImageProvider } from './image.js';

// The emulator in packages/fake-providers: asynchronous jobs, so the job-id recovery path runs.
export function createFakeImage(http: Http, baseUrl: string): ImageProvider {
  return {
    kind: 'async',
    model: 'fake',
    async submit(prompt, signal) {
      const r = await getJson<{ job_id: string }>(http, `${baseUrl}/v1/images`, {
        signal,
        method: 'POST',
        json: { prompt },
      });
      return { jobId: r.job_id };
    },
    async poll(jobId, signal) {
      const r = await getJson<{ status: 'pending' | 'done'; url?: string }>(
        http,
        `${baseUrl}/v1/images/${encodeURIComponent(jobId)}`,
        { signal },
      );
      return { status: r.status, url: r.url && new URL(r.url, baseUrl).toString() };
    },
  };
}
