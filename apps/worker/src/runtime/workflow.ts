import type { Step } from '@ryze/core';

export const POOLS = {
  generate: ['verify', 'text', 'image_submit', 'image_fetch'],
  publish: ['upload', 'draft', 'publish'],
} as const satisfies Record<string, readonly Step[]>;
export type PoolName = keyof typeof POOLS;

export function nextStep(step: Step, imageKind: 'async' | 'sync'): Step | null {
  switch (step) {
    case 'verify':
      return 'text';
    case 'text':
      return imageKind === 'sync' ? 'image_fetch' : 'image_submit';
    case 'image_submit':
      return 'image_fetch';
    case 'image_fetch':
      return 'upload';
    case 'upload':
      return 'draft';
    case 'draft':
      return 'publish';
    case 'publish':
      return null;
  }
}
