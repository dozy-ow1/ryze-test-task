import { logLevelSchema, positiveInt, siteTokenKeySchema } from '@ryze/shared/utils/config';
import { z } from 'zod';

export const apiConfig = z.object({
  DATABASE_URL: z.url(),
  SITE_TOKEN_KEY: siteTokenKeySchema,
  PORT: positiveInt.default(8080),
  LOG_LEVEL: logLevelSchema,
});
