import { z } from 'zod';
import { uuid } from '../../utils/validation.js';
import { MAX_BRIEF_LENGTH, MAX_BULK_ITEMS, MAX_IDEMPOTENCY_KEY_LENGTH } from './constants.js';

export const articleItem = z.object({
  site_id: uuid,
  brief: z.string().trim().min(1).max(MAX_BRIEF_LENGTH),
  idempotency_key: z.string().min(1).max(MAX_IDEMPOTENCY_KEY_LENGTH),
});

export const bulkBody = z.object({ items: z.array(articleItem).min(1).max(MAX_BULK_ITEMS) });
