import { setTimeout as sleep } from 'node:timers/promises';
import { STEPS, type Step } from '@ryze/core';
import type { StepFn } from '../runner.js';

// Milestone 3 placeholder: every step sleeps 100 ms and succeeds. Milestones 4 and 5 replace them.
const stub =
  (step: Step): StepFn<unknown> =>
  async () => {
    await sleep(100);
    return step === 'image_submit' ? { providerRef: 'stub-job' } : {};
  };

export const stubSteps = Object.fromEntries(STEPS.map((step) => [step, stub(step)])) as Record<
  Step,
  StepFn<unknown>
>;
