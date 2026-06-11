/**
 * SSE endpoint for AI task status push notifications.
 *
 * Clients open a single EventSource connection per project and receive
 * real-time updates when background AI tasks (transforms, agent steps, etc.)
 * complete or fail -- replacing all polling patterns.
 *
 * Auth is via query param `token` because EventSource does not support
 * custom headers. The token is validated the same way as requireAuth.
 */

import { Router } from 'express';
import jwt from 'jsonwebtoken';
import jwksClient from 'jwks-rsa';
import { aiTaskEvents, AITaskEvent } from '../../services/aiTaskEventService';

const SUPABASE_JWT_SECRET = process.env.SUPABASE_JWT_SECRET;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const client = jwksClient({
  jwksUri: `${SUPABASE_URL}/auth/v1/.well-known/jwks.json`,
  cache: true,
  cacheMaxEntries: 5,
  cacheMaxAge: 600000,
  timeout: 30000,
  requestHeaders: {
    'apikey': SUPABASE_SERVICE_ROLE_KEY || '',
    'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY || ''}`,
    'User-Agent': 'plotwell-backend'
  }
});

async function verifyToken(token: string): Promise<string | null> {
  const decoded = jwt.decode(token, { complete: true }) as jwt.Jwt | null;
  if (!decoded?.header) return null;

  const { alg, kid } = decoded.header;

  try {
    let payload;
    if (alg === 'ES256' && kid) {
      const key = await client.getSigningKey(kid);
      payload = jwt.verify(token, key.getPublicKey(), { algorithms: ['ES256'] });
    } else if (alg === 'HS256' && SUPABASE_JWT_SECRET) {
      payload = jwt.verify(token, SUPABASE_JWT_SECRET, { algorithms: ['HS256'] });
    } else {
      return null;
    }
    return (payload as jwt.JwtPayload).sub || null;
  } catch {
    return null;
  }
}

const router = Router();

router.get('/task-events', async (req: any, res: any) => {
  const token = req.query.token as string;
  if (!token) {
    return res.status(401).json({ error: 'Missing token' });
  }

  const userId = await verifyToken(token);
  if (!userId) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  const projectId = req.query.project_id as string;
  if (!projectId) {
    return res.status(400).json({ error: 'Missing project_id' });
  }

  // SSE headers — omit Connection: keep-alive (HTTP/1.1 only; irrelevant / harmful for HTTP/2+ / QUIC)
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'X-Accel-Buffering': 'no',
  });
  // Flush headers immediately so the browser opens the stream before the first event
  res.flushHeaders();

  // Send initial connection confirmation
  res.write(`event: connected\ndata: ${JSON.stringify({ projectId })}\n\n`);

  // Heartbeat to keep connection alive (every 30s)
  const heartbeat = setInterval(() => {
    if (!res.writableEnded) {
      res.write(`event: heartbeat\ndata: ${JSON.stringify({ ts: Date.now() })}\n\n`);
    }
  }, 30_000);

  // Listen for AI task events scoped to this user + project
  const onTask = (event: AITaskEvent) => {
    if (event.projectId !== projectId || event.userId !== userId) return;
    if (res.writableEnded) return;

    res.write(`event: ${event.type}\ndata: ${JSON.stringify(event.payload)}\n\n`);
  };

  aiTaskEvents.on('task', onTask);

  // Cleanup on disconnect
  req.on('close', () => {
    clearInterval(heartbeat);
    aiTaskEvents.off('task', onTask);
  });
});

export default router;
