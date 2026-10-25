import { STEPS, type Step } from '@ryze/core';
import { describe, expect, it } from 'vitest';
import { nextStep } from './workflow.js';

describe('nextStep', () => {
  it('chains the seven steps; a sync image provider skips image_submit', () => {
    const chain: (Step | null)[] = ['verify'];

    for (let s = nextStep('verify', 'async'); s; s = nextStep(s, 'async')) {
      chain.push(s);
    }

    expect(chain).toEqual(STEPS);
    expect(nextStep('text', 'sync')).toBe('image_fetch');
    expect(nextStep('publish', 'async')).toBeNull();
  });
});
