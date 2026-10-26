import { type FaultKind, shopifyCredentials } from '@ryze/core';

export interface Faults {
  rate: number;
  kinds: FaultKind[];
}

export interface Media {
  id: string;
  filename: string;
  bytes: Buffer;
}

export interface Post {
  id: string;
  slug: string;
  title: string;
  content: string;
  mediaId: string;
  articleId: string | null;
  url: string | null;
}

export interface Site {
  token: string;
  platform: 'shopify';
  credentials: ReturnType<typeof shopifyCredentials.parse>;
  faults: Faults;
  faultsInjected: Record<FaultKind, number>;
  lastId: number;
  media: Media[];
  posts: Post[];
  uploads: Map<string, Buffer>;
}

export function newSite(token: string, faults: Faults): Site {
  return {
    token,
    platform: 'shopify',
    credentials: shopifyCredentials.parse(JSON.parse(token)),
    faults,
    faultsInjected: { '429': 0, '500': 0, timeout: 0, slow: 0, complete_then_drop: 0 },
    lastId: 1000,
    media: [],
    posts: [],
    uploads: new Map(),
  };
}
