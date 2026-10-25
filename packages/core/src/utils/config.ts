import { z } from 'zod';

// Every service parses its environment with one of these schemas at boot and exits with a readable
// message when something is missing or malformed.

export const logLevelSchema = z
  .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
  .default('info');

export const positiveInt = z.coerce.number().int().positive();

export const siteTokenKeySchema = z
  .string()
  .refine((v) => Buffer.from(v, 'base64').length === 32, 'must be 32 bytes, base64-encoded');

export function loadConfig<T extends z.ZodType>(
  schema: T,
  env: Record<string, string | undefined> = process.env,
): z.output<T> {
  // Compose passes `KEY=` as an empty string; treat it as unset.
  const set = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== ''));
  const parsed = schema.safeParse(set);

  if (parsed.success) {
    return parsed.data;
  }

  const lines = parsed.error.issues.map((i) => `  ${i.path.join('.') || '(env)'}: ${i.message}`);
  console.error(`Invalid configuration:\n${lines.join('\n')}`);
  process.exit(1);
}
