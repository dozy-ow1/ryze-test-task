import { logLevelSchema, siteTokenKeySchema } from '@ryze/core';
import { z } from 'zod';

export const workerConfig = z
  .object({
    DATABASE_URL: z.url(),
    SITE_TOKEN_KEY: siteTokenKeySchema,
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
    LOG_LEVEL: logLevelSchema,
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

export type WorkerConfig = z.output<typeof workerConfig>;
