import { Request, Response, NextFunction } from 'express';

const DEBUG_AI = process.env.DEBUG_AI === 'true';

/**
 * IP Allowlist Middleware
 *
 * Restricts API access to specific IP addresses using the ALLOWED_IPS environment variable.
 *
 * Usage:
 * - Set ALLOWED_IPS="1.2.3.4,5.6.7.8" to allow only those IPs
 * - Leave ALLOWED_IPS empty or unset to allow all IPs (default behavior)
 *
 * Uses Express req.ip with 'trust proxy' setting (configured in server.ts)
 * to correctly resolve client IPs behind proxies like Render/Vercel.
 */
export const ipAllowlistMiddleware = (req: Request, res: Response, next: NextFunction) => {
  const allowedIpsEnv = process.env.ALLOWED_IPS?.trim();

  // If ALLOWED_IPS is not set or empty, allow all requests
  if (!allowedIpsEnv) {
    return next();
  }

  // Parse allowed IPs from environment variable (comma-separated)
  const allowedIps = allowedIpsEnv.split(',').map(ip => ip.trim()).filter(ip => ip.length > 0);

  // If no valid IPs after parsing, allow all requests
  if (allowedIps.length === 0) {
    return next();
  }

  // Use req.ip which respects Express 'trust proxy' setting
  const clientIp = req.ip || req.socket.remoteAddress || 'unknown';

  // Check if client IP is in the allowlist
  const isAllowed = allowedIps.includes(clientIp);

  if (isAllowed) {
    if (DEBUG_AI) console.log(`✅ IP allowed: ${clientIp}`);
    return next();
  } else {
    if (DEBUG_AI) console.log(`🚫 IP blocked: ${clientIp} (Allowed: ${allowedIps.join(', ')})`);
    return res.status(403).json({
      error: 'Access denied',
      message: 'Your IP address is not authorized to access this resource'
    });
  }
};
