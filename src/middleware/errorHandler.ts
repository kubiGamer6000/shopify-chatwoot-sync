import type { Request, Response, NextFunction } from 'express';
import { logger } from '../utils/logger.js';

/** Never leaks internals: logs the error, returns a generic message. */
export function errorHandler(
  err: Error & { status?: number; statusCode?: number; type?: string },
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  const status = err.status ?? err.statusCode ?? 500;
  if (status >= 400 && status < 500) {
    // Body-parser errors (malformed JSON, too large) etc.
    logger.warn('Request rejected', { status, type: err.type });
    res.status(status).json({ error: status === 413 ? 'Payload too large' : 'Bad request' });
    return;
  }
  logger.error('Unhandled error', { message: err.message, stack: err.stack });
  res.status(500).json({ error: 'Internal server error' });
}
