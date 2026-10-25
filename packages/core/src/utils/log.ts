import { pino } from 'pino';

export type Logger = pino.Logger;

// JSON lines on stdout. Tokens and article bodies are never passed to a logger.
export function createLogger(name: string, level = 'info'): Logger {
  return pino({ name, level });
}
