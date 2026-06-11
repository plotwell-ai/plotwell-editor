
import dotenv from "dotenv";

// Load env file from --env-file arg, fallback to .env
// Use override:true because dotenv v17 auto-preloads .env before this runs
const envFileArg = process.argv.find(arg => arg.startsWith('--env-file='));
const envPath = envFileArg ? envFileArg.split('=')[1] : '.env';
dotenv.config({ path: envPath, override: true });
const DEBUG_AI = process.env.DEBUG_AI === 'true';
if (DEBUG_AI) console.log(`🔧 Loaded env from: ${envPath} (STRIPE_PAID_MONTHLY_PRICE_ID=${process.env.STRIPE_PAID_MONTHLY_PRICE_ID || 'NOT SET'})`);

import express from "express";
import aiRouter from "./routes/ai/index";
import videosRouter from "./routes/ai/videos";
import projectsRouter from "./routes/projects";
import charactersRouter from "./routes/characters";
import characterImagesRouter from "./routes/characterImages";
import characterElementsRouter from "./routes/characterElements";
import locationImagesRouter from "./routes/locationImages";
import locationsRouter from "./routes/locations";
import documentsRouter from "./routes/documents";
import scriptsRouter from "./routes/scripts";
import importRouter from "./routes/import";
import seasonsRouter from "./routes/seasons";
import episodesRouter from "./routes/episodes";
import beatsRouter from "./routes/beats";
import structureTemplatesRouter from "./routes/structureTemplates";
import storyboardRoutes from "./routes/storyboard";
import conversationsRouter from "./routes/conversations";
import pricingRouter from "./routes/pricing";
import usageRouter from "./routes/usage";
import productionRouter from "./routes/production";
import userRouter from "./routes/user";
import collaborationRouter from "./routes/collaboration";
import commentsRouter from "./routes/comments";
import scriptDoctorV2Router from "./routes/scriptDoctorV2";
import billingRouter from "./routes/billing";
import unifiedBillingRouter from "./routes/unifiedBilling";
import aiCreditsRouter from "./routes/aiCredits";
import publicShareRouter from "./routes/publicShare";
import toolsRouter from "./routes/tools";
import aiTaskEventsRouter from "./routes/ai/taskEvents";
import studioRouter from "./routes/studio/index";
import { setupCollaborationServer, closeCollaborationServer } from "./services/collaborationServer";
import { requireAuth } from "./middleware/auth";
import { ipAllowlistMiddleware } from "./middleware/ipAllowlist";
import rateLimit from "express-rate-limit";
import { ipKeyGenerator } from "express-rate-limit";
import cors from "cors";
import helmet from "helmet";
import { errorSanitizer } from "./middleware/errorSanitizer";
import { supabase } from "./config/database";
import { cleanupExpiredLocks } from "./services/operationLockService";

const aiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 5, // limit each user to 5 AI requests per minute
  message: "Too many AI requests, please try again later.",
  keyGenerator: (req) => {
    if (req.user?.id) return req.user.id;
    // Use the helper for safe IP fallback
    return ipKeyGenerator(req.ip || 'unknown');
  },
  skip: (req) => req.method === 'GET',
});

// Video generation (MEGA beta) has its own, more generous limiter: animating a
// whole scene means several POSTs in a row, and the client polls job status
// (GET, already exempt). The real cost ceiling is credits, not this limiter.
const videoLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 30,
  message: "Too many video requests, please try again later.",
  keyGenerator: (req) => {
    if (req.user?.id) return req.user.id;
    return ipKeyGenerator(req.ip || 'unknown');
  },
  skip: (req) => req.method === 'GET',
});

const scriptDoctorLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 15, // allow more requests for script doctor (GET analyses + POST analyze)
  message: "Too many script analysis requests, please try again later.",
  keyGenerator: (req) => {
    if (req.user?.id) return req.user.id;
    return ipKeyGenerator(req.ip || 'unknown');
  },
  skip: (req) => req.method === 'GET',
});

// Rate limiter for billing/payment endpoints (prevent checkout spam, verify-payment abuse)
const billingLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10, // 10 requests per minute per user
  message: "Too many billing requests, please try again later.",
  keyGenerator: (req) => {
    if (req.user?.id) return req.user.id;
    return ipKeyGenerator(req.ip || 'unknown');
  }
});

// Stricter rate limiter for AI credits purchase/fulfill (prevent payment spam)
const aiCreditsLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 5, // 5 requests per minute per user
  message: "Too many credit purchase requests, please try again later.",
  keyGenerator: (req) => {
    if (req.user?.id) return req.user.id;
    return ipKeyGenerator(req.ip || 'unknown');
  }
});

// General CRUD rate limiter — prevents spam creation of characters, locations, comments, etc.
const crudLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 60, // 60 write operations per minute per user
  message: "Too many requests, please slow down.",
  keyGenerator: (req) => {
    if (req.user?.id) return req.user.id;
    return ipKeyGenerator(req.ip || 'unknown');
  },
  skip: (req) => req.method === 'GET', // Only limit write operations
});

// Stricter rate limiter for file uploads — prevents storage abuse
const uploadLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10, // 10 uploads per minute per user
  message: "Too many uploads, please try again later.",
  keyGenerator: (req) => {
    if (req.user?.id) return req.user.id;
    return ipKeyGenerator(req.ip || 'unknown');
  }
});

const app = express();

// Trust first proxy (Render/Vercel) so req.ip returns the real client IP
app.set('trust proxy', 1);

// Security headers
app.use(helmet());

// Sanitize error responses in production (strip internal details)
app.use(errorSanitizer);

// CORS configuration with environment variable support
const allowedOrigins: string[] = [];

// Only allow localhost origins in non-production environments
if (process.env.NODE_ENV !== 'production') {
  allowedOrigins.push(
    "http://localhost:5173",
    "http://localhost:5174",
    "http://localhost:5175",
    "http://localhost:5176",
    "http://localhost:5177",
    "http://localhost:5178"
  );
}

// Add production/dev frontend URLs from environment variable
// Supports comma-separated list: app URL + tool subdomains
// e.g. FRONTEND_URL=https://app.plotwell.co,https://scripts.plotwell.co,https://storyboard.plotwell.co,https://budget.plotwell.co
if (process.env.FRONTEND_URL) {
  const frontendUrls = process.env.FRONTEND_URL.split(',').map(url => url.trim());
  allowedOrigins.push(...frontendUrls);
}

app.use(cors({
  origin: allowedOrigins,
  credentials: true
}));

// Apply IP allowlist middleware early (before routes, after CORS)
app.use(ipAllowlistMiddleware);

// Health check endpoint (unauthenticated, used by Render/monitoring)
app.get('/health', async (_req, res) => {
  try {
    const { error } = await supabase.from('users').select('id').limit(1);
    if (error) {
      return res.status(503).json({ status: 'unhealthy', db: 'unreachable' });
    }
    res.json({ status: 'healthy', db: 'connected' });
  } catch {
    res.status(503).json({ status: 'unhealthy', db: 'unreachable' });
  }
});

// Handle billing webhooks first (before JSON parsing) to preserve raw body
// Only handle webhook route specifically to avoid conflicts
app.use("/api/billing/stripe-webhook", billingRouter);

// Default payload limit — most routes need far less than 50MB
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));

// Unified billing API (new endpoints, requires JSON parsing)
app.use("/api/billing", requireAuth, billingLimiter, unifiedBillingRouter);

// Extended timeout middleware for AI operations that may take several minutes
const extendedTimeoutMiddleware = (req: express.Request, res: express.Response, next: express.NextFunction) => {
  // Set timeout to 11 minutes for AI routes (less than server timeout)
  req.setTimeout(11 * 60 * 1000);
  res.setTimeout(11 * 60 * 1000);
  next();
};

// AI task events SSE — lightweight push notifications, no rate limit needed
app.use("/api/ai", aiTaskEventsRouter);
// Studio v2 — must be before aiRouter so /api/ai/studio/* doesn't fall into the generic ai handler
app.use("/api/ai/studio", requireAuth, aiLimiter, extendedTimeoutMiddleware, studioRouter);
// Video generation — mounted before the generic aiRouter so it uses videoLimiter (not the tight 5/min aiLimiter)
app.use("/api/ai", requireAuth, videoLimiter, extendedTimeoutMiddleware, videosRouter);
app.use("/api/ai", requireAuth, aiLimiter, extendedTimeoutMiddleware, aiRouter);
// Public routes - MUST come before generic /api routes to avoid requireAuth
app.use("/api/pricing", pricingRouter);

// Public app config — exposes feature flags to the frontend (no secrets)
app.get("/api/config", (_req, res) => {
  const onboardingMode = process.env.ONBOARDING_MODE || 'freemium';
  const trialDays = parseInt(process.env.TRIAL_DAYS || '7', 10);
  res.json({
    onboarding_mode: onboardingMode, // 'freemium' | 'trial_7d'
    trial_days: trialDays,
  });
});

// Collaboration routes - has some public endpoints (invitation details) so must come before generic /api routes
// Auth is handled per-route inside the router
app.use("/api/collaboration", collaborationRouter);

// Public share routes - has public endpoints (share view) so must come before generic /api routes
// Auth is handled per-route inside the router
app.use("/api/share", publicShareRouter);

// Mini-tool routes — mix of public (scenes/preview) and auth-required (generate)
// Auth is handled per-route inside the router
app.use("/api/tools", toolsRouter);

// Protected routes
app.use("/api/projects", requireAuth, crudLimiter, projectsRouter);
app.use("/api", requireAuth, crudLimiter, seasonsRouter);
app.use("/api", requireAuth, crudLimiter, episodesRouter);
app.use("/api", requireAuth, crudLimiter, beatsRouter);
app.use("/api", requireAuth, crudLimiter, structureTemplatesRouter);
app.use("/api/characters", requireAuth, crudLimiter, charactersRouter);
app.use("/api/characters/:characterId/images", requireAuth, uploadLimiter, characterImagesRouter);
app.use("/api/characters/:characterId/elements", requireAuth, crudLimiter, characterElementsRouter);
app.use("/api/locations", requireAuth, crudLimiter, locationsRouter);
app.use("/api/locations/:locationId/images", requireAuth, uploadLimiter, locationImagesRouter);
app.use("/api/documents", requireAuth, crudLimiter, documentsRouter);
// Scripts and imports may contain large content — allow higher payload limit
const largePayload = express.json({ limit: '50mb' });
app.use("/api/scripts", requireAuth, largePayload, scriptsRouter);
app.use("/api", requireAuth, largePayload, importRouter);
app.use("/api/storyboard", requireAuth, uploadLimiter, storyboardRoutes);
app.use("/api/conversations", requireAuth, crudLimiter, conversationsRouter);
app.use("/api/usage", requireAuth, usageRouter);
// AI Credits - one-time purchases (requires auth + rate limiting)
app.use("/api/ai-credits", requireAuth, aiCreditsLimiter, aiCreditsRouter);
// Production planning suite — available to all authenticated users (production features are on the free plan)
app.use("/api/production", requireAuth, extendedTimeoutMiddleware, productionRouter);
const userLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  message: "Too many requests, please try again later.",
  keyGenerator: (req) => {
    if (req.user?.id) return req.user.id;
    return ipKeyGenerator(req.ip || 'unknown');
  }
});
app.use("/api/user", requireAuth, userLimiter, userRouter);
// Collaboration routes moved earlier (before generic /api routes) to allow public endpoints
app.use("/api/comments", requireAuth, crudLimiter, commentsRouter);
app.use("/api/script-doctor/v2", requireAuth, scriptDoctorLimiter, extendedTimeoutMiddleware, scriptDoctorV2Router);

process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  closeCollaborationServer();
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  closeCollaborationServer();
  process.exit(1);
});

function gracefulShutdown(signal: string) {
  if (DEBUG_AI) console.log(`🛑 ${signal} received, starting graceful shutdown...`);
  closeCollaborationServer();

  // Stop accepting new connections and drain in-flight requests
  server.close(() => {
    if (DEBUG_AI) console.log('✅ All connections drained, exiting.');
    process.exit(0);
  });

  // Force exit after 30s if connections don't drain
  setTimeout(() => {
    console.error('⚠️ Forced shutdown after 30s timeout');
    process.exit(1);
  }, 30_000).unref();
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

const PORT = process.env.PORT || 3001;
const server = app.listen(PORT, () => {
  const isDev = process.env.NODE_ENV !== 'production';
  if (DEBUG_AI) console.log(`Server running on port ${PORT}`);
  
  // Environment check
  const requiredEnvVars = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_JWT_SECRET'];
  const missingVars = requiredEnvVars.filter(varName => !process.env[varName]);
  
  if (missingVars.length > 0) {
    console.error("Missing required environment variables:", missingVars);
  } else {
    if (DEBUG_AI) console.log("All required environment variables loaded");
  }
  
  if (isDev) {
    if (DEBUG_AI) console.log("DEV MODE: Simulated payments enabled");
    if (DEBUG_AI) console.log("   - Use /api/pricing/dev/* endpoints for testing");
    if (DEBUG_AI) console.log("   - No real Stripe charges will be processed");
  } else {
    if (DEBUG_AI) console.log("🏭 PRODUCTION MODE: Real Stripe integration required");
  }
  
  if (DEBUG_AI) console.log("Server listening and ready to accept connections");
  
  // Setup collaboration WebSocket server
  setupCollaborationServer(server);

  // Clean up expired operation locks every 5 minutes
  setInterval(() => {
    cleanupExpiredLocks().catch(err => console.error('❌ Lock cleanup error:', err));
  }, 5 * 60 * 1000);

  // Purge soft-deleted projects older than 90 days (runs once daily)
  setInterval(async () => {
    try {
      const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
      const { data } = await supabase
        .from('projects')
        .delete()
        .eq('deleted', true)
        .lt('updated_at', cutoff)
        .select('id');
      if (data?.length) {
        if (DEBUG_AI) console.log(`🗑️ Purged ${data.length} soft-deleted project(s) older than 90 days`);
      }
    } catch (err) {
      console.error('❌ Soft delete cleanup error:', err);
    }
  }, 24 * 60 * 60 * 1000); // Every 24 hours
});

// Configure server timeouts for long AI generation requests
server.timeout = 12 * 60 * 1000; // 12 minutes for server timeout (longer than OpenAI timeout)
server.keepAliveTimeout = 13 * 60 * 1000; // 13 minutes for keep-alive timeout

server.on('error', (error) => {
  console.error('Server error:', error);
});
