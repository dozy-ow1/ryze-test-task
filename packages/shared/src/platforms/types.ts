// A customer site as the adapters see it: the token is decrypted and must never be logged.
export interface Site {
  id: string;
  platform: 'shopify';
  base_url: string;
  token: string;
}

export interface RemotePost {
  id: string;
  status: 'draft' | 'live';
  url?: string;
  articleId: string | null;
}

export interface DraftInput {
  title: string;
  slug: string;
  bodyHtml: string;
  mediaId: string;
  articleId: string;
}

// The platform implementation is injected by the worker factory. Every lookup lets a retry find
// what an earlier attempt already did: by file name, by slug, by post id.
export interface PlatformAdapter {
  verify(site: Site, signal?: AbortSignal): Promise<void>;
  findMedia(site: Site, filename: string, signal?: AbortSignal): Promise<string | null>;
  uploadMedia(site: Site, filename: string, bytes: Buffer, signal?: AbortSignal): Promise<string>;
  findBySlug(site: Site, slug: string, signal?: AbortSignal): Promise<RemotePost | null>;
  createDraft(site: Site, a: DraftInput, signal?: AbortSignal): Promise<string>;
  getStatus(
    site: Site,
    postId: string,
    signal?: AbortSignal,
  ): Promise<{ status: 'draft' | 'live'; url?: string }>;
  publish(site: Site, postId: string, signal?: AbortSignal): Promise<string>; // public url
  deleteDraft(site: Site, postId: string, signal?: AbortSignal): Promise<void>; // the reconciler removes stray drafts
}
