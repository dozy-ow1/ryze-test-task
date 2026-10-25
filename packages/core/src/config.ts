import { z } from 'zod';

// Every service parses its environment with one of these schemas at boot and exits with a readable
// message when something is missing or malformed.

const logLevel = z
  .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
  .default('info');

const positiveInt = z.coerce.number().int().positive();

const siteTokenKey = z
  .string()
  .refine((v) => Buffer.from(v, 'base64').length === 32, 'must be 32 bytes, base64-encoded');

export const FAULT_KINDS = ['429', '500', 'timeout', 'slow', 'complete_then_drop'] as const;
export type FaultKind = (typeof FAULT_KINDS)[number];

export const migrateConfig = z.object({
  DATABASE_URL: z.url(),
});

export const apiConfig = z.object({
  DATABASE_URL: z.url(),
  SITE_TOKEN_KEY: siteTokenKey,
  PORT: positiveInt.default(8080),
  LOG_LEVEL: logLevel,
});

export const workerConfig = z
  .object({
    DATABASE_URL: z.url(),
    SITE_TOKEN_KEY: siteTokenKey,
    S3_ENDPOINT: z.url(),
    S3_BUCKET: z.string().min(1),
    S3_ACCESS_KEY: z.string().min(1),
    S3_SECRET_KEY: z.string().min(1),
    LLM_PROVIDER: z.enum(['mock', 'anthropic']).default('mock'),
    IMAGE_PROVIDER: z.enum(['mock', 'openai']).default('mock'),
    LLM_BASE_URL: z.url().optional(),
    IMAGE_BASE_URL: z.url().optional(),
    ANTHROPIC_API_KEY: z.string().optional(),
    ANTHROPIC_MODEL: z.string().default('claude-sonnet-5-5'),
    OPENAI_API_KEY: z.string().optional(),
    OPENAI_IMAGE_MODEL: z.string().default('gpt-image-1'),
    MOCK_WORDPRESS_URL: z.url().optional(),
    LOG_LEVEL: logLevel,
  })
  .superRefine((c, ctx) => {
    const need = (key: keyof typeof c, when: string) => {
      if (!c[key]) {
        ctx.addIssue({ code: 'custom', path: [key], message: `required when ${when}` });
      }
    };

    if (c.LLM_PROVIDER === 'mock') {
      need('LLM_BASE_URL', 'LLM_PROVIDER=mock');
    }

    if (c.LLM_PROVIDER === 'anthropic') {
      need('ANTHROPIC_API_KEY', 'LLM_PROVIDER=anthropic');
    }

    if (c.IMAGE_PROVIDER === 'mock') {
      need('IMAGE_BASE_URL', 'IMAGE_PROVIDER=mock');
    }

    if (c.IMAGE_PROVIDER === 'openai') {
      need('OPENAI_API_KEY', 'IMAGE_PROVIDER=openai');
    }
  });

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
  LOG_LEVEL: logLevel,
});

export type WorkerConfig = z.output<typeof workerConfig>;

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
