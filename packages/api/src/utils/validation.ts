import { z } from 'zod';
import { HttpProblem } from './errors.js';

export function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value);

  if (!r.success) {
    throw new HttpProblem(400, 'validation failed', r.error.issues);
  }

  return r.data;
}

export const uuid = z.uuid().transform((v) => v.toLowerCase());
export const idParam = z.object({ id: uuid });
