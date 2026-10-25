import { z } from 'zod';
import { logLevelSchema, positiveInt } from '../utils/config.js';

export const FAULT_KINDS = ['429', '500', 'timeout', 'slow', 'complete_then_drop'] as const;
export type FaultKind = (typeof FAULT_KINDS)[number];

export const mockConfig = z.object({
  PORT: positiveInt,
  FAULT_RATE: z.coerce.number().min(0).max(1).default(0),
  FAULT_KINDS: z
    .string()
    .default(FAULT_KINDS.join(','))
    .transform((v) =>
      v
        .split(',')
        .map((k) => k.trim())
        .filter(Boolean),
    )
    .pipe(z.array(z.enum(FAULT_KINDS))),
  LOG_LEVEL: logLevelSchema,
});
