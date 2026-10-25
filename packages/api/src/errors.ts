export class HttpProblem extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

const DB_DOWN_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'ETIMEDOUT',
  'EAI_AGAIN',
  '57P01', // admin_shutdown (connection terminated)
  '57P02',
  '57P03', // cannot_connect_now
  '08000',
  '08003',
  '08006',
]);

export function isDbUnavailable(err: unknown): boolean {
  const e = err as { code?: string; message?: string; errors?: unknown[] };
  if (e?.code && DB_DOWN_CODES.has(e.code)) {
    return true;
  }
  const message = e?.message ?? '';
  if (
    /Connection terminated|not queryable|timeout exceeded when trying to connect/i.test(message)
  ) {
    return true;
  }
  return Array.isArray(e?.errors) && e.errors.some(isDbUnavailable);
}
