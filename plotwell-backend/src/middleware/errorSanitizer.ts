import { Request, Response, NextFunction } from 'express';

/**
 * Response sanitizer middleware.
 * In production, intercepts res.json() to strip internal error details
 * (DB schema info, stack traces, Stripe internals) from error responses.
 * In development, passes everything through for debugging.
 */
export const errorSanitizer = (req: Request, res: Response, next: NextFunction) => {
  if (process.env.NODE_ENV === 'development') {
    return next();
  }

  const originalJson = res.json.bind(res);

  res.json = function (body: any) {
    // Only sanitize error responses (4xx/5xx)
    if (res.statusCode >= 400 && body && typeof body === 'object') {
      // Strip 'details' field — often contains error.message with DB/internal info
      if ('details' in body) {
        delete body.details;
      }

      // If 'error' field looks like a raw exception message (contains technical patterns),
      // replace with a generic message while preserving intentional user-facing errors
      if (typeof body.error === 'string' && looksLikeInternalError(body.error)) {
        body.error = 'Internal server error';
      }
    }

    return originalJson(body);
  } as any;

  next();
};

/**
 * Detects error messages that likely come from internal exceptions
 * rather than intentional user-facing messages.
 */
function looksLikeInternalError(msg: string): boolean {
  const internalPatterns = [
    /duplicate key/i,
    /violates.*constraint/i,
    /relation ".*" does not exist/i,
    /column ".*" (does not exist|of relation)/i,
    /syntax error at/i,
    /ECONNREFUSED/i,
    /ETIMEDOUT/i,
    /Cannot read propert/i,
    /is not a function/i,
    /undefined is not/i,
    /TypeError:/i,
    /ReferenceError:/i,
    /SyntaxError:/i,
    /FATAL:/i,
    /at Object\./i,
    /at Module\./i,
    /\.ts:\d+:\d+/,
    /\.js:\d+:\d+/,
    /stack.*trace/i,
    /PGRST\d+/i,
    /supabase/i,
    /pgbouncer/i,
  ];

  return internalPatterns.some(pattern => pattern.test(msg));
}
