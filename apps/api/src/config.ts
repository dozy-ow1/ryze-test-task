import { logLevelSchema, positiveInt, siteTokenKeySchema } from '@ryze/core';
import { z } from 'zod';

export const apiConfig = z.object({
  DATABASE_URL: z.url(),
  SITE_TOKEN_KEY: siteTokenKeySchema,
  PORT: positiveInt.default(8080),
  LOG_LEVEL: logLevelSchema,
});
