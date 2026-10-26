import type { Completion, Database, Logger, Operation, Site, Step } from '@ryze/shared';
import type { LimitFunction } from 'p-limit';

export interface Article {
  id: string;
  site_id: string;
  brief: string;
  title: string | null;
  slug: string | null;
  body_html: string | null;
  image_prompt: string | null;
  remote_media_id: string | null;
  remote_post_id: string | null;
}

export interface StepContext<C> {
  op: Operation;
  article: Article;
  site: Site & { verified_at: Date | null; tokenVersion?: Buffer };
  clients: C;
  log: Logger;
  signal: AbortSignal; // aborted when the lease is lost
}

// What a step hands back for COMPLETE: its usage, its own columns, and the job id the next row
// carries (image_submit only). The runner picks the next step.
export type StepResult = Pick<Completion, 'usage' | 'write'> & { providerRef?: string };
export type StepFn<C> = (ctx: StepContext<C>) => Promise<StepResult>;

export interface Runner<C> {
  db: Database;
  log: Logger;
  steps: Record<Step, StepFn<C>>;
  clients: C;
  siteTokenKey: string;
  leaseSeconds: number;
  maxAttempts: number;
  imageKind: 'async' | 'sync'; // a sync image provider has no image_submit step
  imageLimit: LimitFunction;
}
