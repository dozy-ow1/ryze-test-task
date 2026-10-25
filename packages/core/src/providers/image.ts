// Identical for the fake and the real provider. An async provider takes a job and is polled for
// it; a sync one returns the image from one call (the pipeline then has no image_submit step).
export interface ImageProvider {
  kind: 'async' | 'sync';
  model?: string;
  submit?(prompt: string, signal?: AbortSignal): Promise<{ jobId: string }>;
  poll?(jobId: string, signal?: AbortSignal): Promise<{ status: 'pending' | 'done'; url?: string }>;
  generate?(prompt: string, signal?: AbortSignal): Promise<Buffer>;
}
